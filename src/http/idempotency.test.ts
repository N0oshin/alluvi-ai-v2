import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app.js';
import { AppError, type ErrorDetail } from './errors.js';
import {
  addIdempotency,
  hashRequest,
  memoryIdempotencyStore,
  readIdempotencyKey,
  stableStringify,
  type IdempotencyStore,
} from './idempotency.js';
import { validate } from './validate.js';

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

const bodySchema = z.strictObject({ amount_ml: z.number().int().min(1) });

// Builds the app with a creating POST that opts in and a plain POST that does
// not. The handler is a spy so tests can count how often it really ran.
function buildTestApp(store: IdempotencyStore = memoryIdempotencyStore()) {
  const app = buildApp({ checkDatabase: () => Promise.resolve(), idempotencyStore: store });
  const handler = vi.fn((amountMl: number) => ({ id: randomUUID(), amount_ml: amountMl }));

  app.post('/water', { config: { idempotent: true } }, (request, reply) => {
    const body = validate(bodySchema, request.body);
    if (body.amount_ml === 500) {
      throw new Error('database exploded');
    }
    return reply.code(201).send(handler(body.amount_ml));
  });
  app.post('/water/empty', { config: { idempotent: true } }, (_request, reply) => {
    handler(0);
    return reply.code(204).send();
  });
  app.post('/echo', (request) => request.body);

  return { app, handler };
}

const post = (
  app: ReturnType<typeof buildTestApp>['app'],
  url: string,
  key: string | string[] | undefined,
  body: unknown = { amount_ml: 250 },
) =>
  app.inject({
    method: 'POST',
    url,
    headers: key === undefined ? {} : { 'idempotency-key': key },
    payload: body as Record<string, unknown>,
  });

describe('readIdempotencyKey', () => {
  it('accepts a UUID and lowercases it', () => {
    expect(
      readIdempotencyKey({ 'idempotency-key': ' 0191E4D2-7D55-7B4E-8E63-1E5F2D0B5C11 ' }),
    ).toBe('0191e4d2-7d55-7b4e-8e63-1e5f2d0b5c11');
  });

  it('refuses a missing, malformed or repeated header', () => {
    expect(() => readIdempotencyKey({})).toThrow(AppError);
    expect(() => readIdempotencyKey({ 'idempotency-key': 'order-1' })).toThrow(AppError);
    expect(() => readIdempotencyKey({ 'idempotency-key': [randomUUID(), randomUUID()] })).toThrow(
      AppError,
    );
  });
});

describe('stableStringify and hashRequest', () => {
  it('ignores key order at every level', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
    );
    expect(hashRequest('post', '/v1/meals', { b: 1, a: 2 })).toBe(
      hashRequest('POST', '/v1/meals', { a: 2, b: 1 }),
    );
  });

  it('tells different requests apart', () => {
    const body = { a: 1 };
    expect(hashRequest('POST', '/v1/meals', body)).not.toBe(hashRequest('POST', '/v1/water', body));
    expect(hashRequest('POST', '/v1/meals', body)).not.toBe(
      hashRequest('POST', '/v1/meals', { a: 2 }),
    );
    expect(hashRequest('POST', '/v1/meals', undefined)).not.toBe(
      hashRequest('POST', '/v1/meals', {}),
    );
  });
});

describe('idempotent routes', () => {
  it('requires the header', async () => {
    const { app, handler } = buildTestApp();

    const response = await post(app, '/water', undefined);

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details).toEqual([
      { field: 'Idempotency-Key', code: 'required', message: 'This header is required.' },
    ]);
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires a UUID', async () => {
    const { app } = buildTestApp();

    const response = await post(app, '/water', 'order-1');

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details).toEqual([
      { field: 'Idempotency-Key', code: 'invalid', message: 'Must be a UUID.' },
    ]);
    await app.close();
  });

  it('runs the handler once and replays its response', async () => {
    const { app, handler } = buildTestApp();
    const key = randomUUID();

    const first = await post(app, '/water', key);
    const replay = await post(app, '/water', key);

    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(handler).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('treats a body with reordered keys as the same request', async () => {
    const { app, handler } = buildTestApp();
    const key = randomUUID();
    app.post('/pair', { config: { idempotent: true } }, (_request, reply) =>
      reply.code(201).send(handler(1)),
    );

    await post(app, '/pair', key, { a: 1, b: 2 });
    const replay = await post(app, '/pair', key, { b: 2, a: 1 });

    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(handler).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('refuses the same key with a different body', async () => {
    const { app, handler } = buildTestApp();
    const key = randomUUID();

    await post(app, '/water', key, { amount_ml: 250 });
    const reused = await post(app, '/water', key, { amount_ml: 300 });

    expect(reused.statusCode).toBe(422);
    expect(reused.json<ErrorBody>().error.code).toBe('idempotency_key_reused');
    expect(handler).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('refuses the same key on a different path', async () => {
    const { app } = buildTestApp();
    const key = randomUUID();

    await post(app, '/water', key);
    const reused = await post(app, '/water/empty', key);

    expect(reused.json<ErrorBody>().error.code).toBe('idempotency_key_reused');
    await app.close();
  });

  it('replays a 4xx response without running the handler again', async () => {
    const { app, handler } = buildTestApp();
    const key = randomUUID();

    const first = await post(app, '/water', key, { amount_ml: 0 });
    const replay = await post(app, '/water', key, { amount_ml: 0 });

    expect(first.statusCode).toBe(422);
    expect(replay.statusCode).toBe(422);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('replays an empty 204 response', async () => {
    const { app, handler } = buildTestApp();
    const key = randomUUID();

    await post(app, '/water/empty', key);
    const replay = await post(app, '/water/empty', key);

    expect(replay.statusCode).toBe(204);
    expect(replay.body).toBe('');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(handler).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('does not save a 5xx response, so a retry runs the handler again', async () => {
    const { app } = buildTestApp();
    const key = randomUUID();

    const first = await post(app, '/water', key, { amount_ml: 500 });
    const retry = await post(app, '/water', key, { amount_ml: 500 });

    expect(first.statusCode).toBe(500);
    expect(retry.statusCode).toBe(500);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    await app.close();
  });

  it('answers 409 while the first request is still running', async () => {
    const store = memoryIdempotencyStore();
    const { app, handler } = buildTestApp(store);
    const key = randomUUID();
    const hash = hashRequest('POST', '/water', { amount_ml: 250 });
    // The claim without a response is what a request in flight looks like.
    await store.claim('00000000-0000-0000-0000-000000000000', key, hash, new Date());

    const response = await post(app, '/water', key);

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.details[0]?.code).toBe('in_progress');
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('runs the handler again once the key has expired', async () => {
    const store = memoryIdempotencyStore(0);
    const { app, handler } = buildTestApp(store);
    const key = randomUUID();

    await post(app, '/water', key);
    const again = await post(app, '/water', key);

    expect(again.headers['idempotent-replayed']).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('leaves routes that did not opt in alone', async () => {
    const { app } = buildTestApp();

    const response = await post(app, '/echo', undefined, { hello: 'world' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ hello: 'world' });
    await app.close();
  });
});

describe('subject scoping', () => {
  it('keeps keys of different subjects apart', async () => {
    const { app: base } = buildTestApp();
    await base.close();

    // A bare Fastify app with the hook reading the subject from a test header.
    const { default: Fastify } = await import('fastify');
    const app = Fastify();
    addIdempotency(app, {
      store: memoryIdempotencyStore(),
      subjectOf: (request) => String(request.headers['x-test-subject']),
    });
    const handler = vi.fn(() => ({ ok: true }));
    app.post('/thing', { config: { idempotent: true } }, () => handler());
    const key = randomUUID();

    await app.inject({
      method: 'POST',
      url: '/thing',
      headers: { 'idempotency-key': key, 'x-test-subject': 'alice' },
      payload: {},
    });
    await app.inject({
      method: 'POST',
      url: '/thing',
      headers: { 'idempotency-key': key, 'x-test-subject': 'bob' },
      payload: {},
    });

    expect(handler).toHaveBeenCalledTimes(2);
    await app.close();
  });
});

describe('memoryIdempotencyStore', () => {
  it('deletes expired records and counts them', async () => {
    const store = memoryIdempotencyStore(1000);
    const start = new Date('2026-10-07T10:00:00Z');
    await store.claim('s', 'k1', 'h', start);
    await store.claim('s', 'k2', 'h', new Date(start.getTime() + 500));

    expect(await store.deleteExpired(new Date(start.getTime() + 1000))).toBe(1);
    expect(await store.deleteExpired(new Date(start.getTime() + 1000))).toBe(0);
    expect(await store.claim('s', 'k2', 'h', start)).toEqual({ requestHash: 'h', response: null });
  });

  it('releases a claim', async () => {
    const store = memoryIdempotencyStore();
    const now = new Date();
    await store.claim('s', 'k', 'h', now);
    await store.release('s', 'k');

    expect(await store.claim('s', 'k', 'h', now)).toBeNull();
  });
});
