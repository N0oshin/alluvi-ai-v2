// Idempotency middleware.
//

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from './errors.js';
import { pathOf } from './logging.js';

// Replays are honoured for 24 hours.
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface StoredResponse {
  status: number;
  body: unknown;
}

// What the store knows about a key: the hash of the request that claimed it
// and, once the handler has finished, its response.
export interface IdempotencyRecord {
  requestHash: string;
  response: StoredResponse | null;
}

// Claim: Before your server starts processing a request, it calls claim. It passes who is asking (subjectId), their unique ticket (key), a summary of what they want (requestHash), and the current time (now).
export interface IdempotencyStore {
  claim(
    subjectId: string,
    key: string,
    requestHash: string,
    now: Date,
  ): Promise<IdempotencyRecord | null>;
  // Saves the response of a claimed key.
  complete(subjectId: string, key: string, response: StoredResponse): Promise<void>;
  // Gives a claimed key back, so the next request with it runs the handler.
  release(subjectId: string, key: string): Promise<void>;
  // Removes records whose expiry is at or before `now`. Resolves to how many.
  deleteExpired(now: Date): Promise<number>;
}

export interface IdempotencyOptions {
  store: IdempotencyStore;
  // Who the key belongs to: a user id or a guest session id. Keys are scoped
  // per subject, so two subjects can use the same key without colliding.
  subjectOf: (request: FastifyRequest) => string;
}

// Tells TypeScript about the two things this file adds to Fastify's own types:
// the `idempotent` route config flag and the per-request state the two hooks
// share.
declare module 'fastify' {
  interface FastifyContextConfig {
    idempotent?: boolean;
  }
  interface FastifyRequest {
    idempotency: { subjectId: string; key: string } | null;
  }
}

const keySchema = z.uuid();

// Reads and checks the header. Missing or malformed is a 422 on the field
// 'Idempotency-Key'.
export function readIdempotencyKey(headers: FastifyRequest['headers']): string {
  const value = headers['idempotency-key'];

  if (value === undefined) {
    throw new AppError('validation_failed', [
      { field: 'Idempotency-Key', code: 'required', message: 'This header is required.' },
    ]);
  }

  // A header sent twice arrives as an array; that is refused as well.
  const result = typeof value === 'string' ? keySchema.safeParse(value.trim()) : undefined;
  if (result === undefined || !result.success) {
    throw new AppError('validation_failed', [
      { field: 'Idempotency-Key', code: 'invalid', message: 'Must be a UUID.' },
    ]);
  }
  return result.data.toLowerCase();
}

//  turns any JSON value into text, but with object keys sorted alphabetically at every level.
//Why: plain JSON.stringify gives different text for {a:1, b:2} and {b:2, a:1}, yet they are the same request.
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

//builds the fingerprint
export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${stableStringify(body)}`)
    .digest('hex');
}

// Parses what the onSend hook receives: the serialized body as a string, or
// nothing at all for an empty response such as a 204.
function parsePayload(payload: unknown): unknown {
  if (typeof payload === 'string' && payload.length > 0) {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return payload;
    }
  }
  return null;
}

export function addIdempotency(app: FastifyInstance, options: IdempotencyOptions): void {
  const { store, subjectOf } = options;

  app.decorateRequest('idempotency', null);

  // preHandler runs after the body is parsed and before the handler, so a
  // body that is not JSON is already a 400 by now and never reaches the store.
  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.config.idempotent !== true) {
      return;
    }

    const key = readIdempotencyKey(request.headers);
    const subjectId = subjectOf(request);
    const requestHash = hashRequest(request.method, pathOf(request.url), request.body);

    const existing = await store.claim(subjectId, key, requestHash, new Date());
    if (existing === null) {
      // Claimed: remember the key so onSend can save the response.
      request.idempotency = { subjectId, key };
      return;
    }

    if (existing.requestHash !== requestHash) {
      throw new AppError('idempotency_key_reused');
    }
    if (existing.response === null) {
      throw new AppError('conflict', [
        {
          field: 'Idempotency-Key',
          code: 'in_progress',
          message: 'The first request with this key has not finished. Retry shortly.',
        },
      ]);
    }

    // A replay: send the saved response and stop here. Returning the reply
    // tells Fastify the hook has answered the request itself.
    return reply
      .header('Idempotent-Replayed', 'true')
      .code(existing.response.status)
      .send(existing.response.body);
  });

  // onSend runs for every response, including an error envelope produced by
  // the error handler, with the body already serialized. `payload` is handed
  // back unchanged.
  app.addHook('onSend', async (request, reply, payload: unknown) => {
    const claimed = request.idempotency;
    if (claimed === null) {
      return payload;
    }
    request.idempotency = null;

    if (reply.statusCode >= 500) {
      await store.release(claimed.subjectId, claimed.key);
    } else {
      await store.complete(claimed.subjectId, claimed.key, {
        status: reply.statusCode,
        body: parsePayload(payload),
      });
    }
    return payload;
  });
}

// In-memory store for tests and for running the app without a database.
// Same behaviour as the database store, including expiry.
export function memoryIdempotencyStore(ttlMs: number = IDEMPOTENCY_TTL_MS): IdempotencyStore {
  const records = new Map<string, IdempotencyRecord & { expiresAt: Date }>();
  const keyOf = (subjectId: string, key: string) => `${subjectId}:${key}`;

  return {
    // The interface promises a Promise, so each method wraps its plain result
    // in Promise.resolve; nothing here needs to wait for anything.
    claim(subjectId, key, requestHash, now) {
      const id = keyOf(subjectId, key);
      const existing = records.get(id);
      if (existing !== undefined && existing.expiresAt > now) {
        return Promise.resolve({ requestHash: existing.requestHash, response: existing.response });
      }
      records.set(id, {
        requestHash,
        response: null,
        expiresAt: new Date(now.getTime() + ttlMs),
      });
      return Promise.resolve(null);
    },
    complete(subjectId, key, response) {
      const existing = records.get(keyOf(subjectId, key));
      if (existing !== undefined) {
        existing.response = response;
      }
      return Promise.resolve();
    },
    release(subjectId, key) {
      records.delete(keyOf(subjectId, key));
      return Promise.resolve();
    },
    deleteExpired(now) {
      let deleted = 0;
      for (const [id, record] of records) {
        if (record.expiresAt <= now) {
          records.delete(id);
          deleted += 1;
        }
      }
      return Promise.resolve(deleted);
    },
  };
}
