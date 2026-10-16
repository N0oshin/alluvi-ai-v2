// The IdempotencyStore (src/shared/http/idempotency.ts) on the idempotency_keys table.
//
// The unique index on (subject_id, key) does the hard part: when two requests
// with the same key arrive at once, both try to insert, exactly one succeeds,
// and `on conflict do nothing` lets the other read the winner's row instead of
// failing. See docs/backend-notes.md entry 25.

import { and, eq, lte } from 'drizzle-orm';
import {
  IDEMPOTENCY_TTL_MS,
  type IdempotencyRecord,
  type IdempotencyStore,
} from '../http/idempotency.js';
import { idempotencyKeys } from './schema.js';
import type { Database } from '../../db/index.js';

export function createIdempotencyStore(
  db: Database,
  ttlMs: number = IDEMPOTENCY_TTL_MS,
): IdempotencyStore {
  const sameKey = (subjectId: string, key: string) =>
    and(eq(idempotencyKeys.subjectId, subjectId), eq(idempotencyKeys.key, key));

  async function claim(
    subjectId: string,
    key: string,
    requestHash: string,
    now: Date,
    attempt = 1,
  ): Promise<IdempotencyRecord | null> {
    const inserted = await db
      .insert(idempotencyKeys)
      .values({ subjectId, key, requestHash, expiresAt: new Date(now.getTime() + ttlMs) })
      .onConflictDoNothing({ target: [idempotencyKeys.subjectId, idempotencyKeys.key] })
      .returning({ id: idempotencyKeys.id });

    if (inserted.length > 0) {
      return null;
    }

    const existing = await db.query.idempotencyKeys.findFirst({
      where: sameKey(subjectId, key),
    });

    // Either the row vanished between the two statements (released by the
    // request that held it) or it has expired: clear it and insert once more.
    if (existing === undefined || existing.expiresAt <= now) {
      if (existing !== undefined) {
        await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, existing.id));
      }
      if (attempt >= 2) {
        throw new Error('idempotency key could not be claimed');
      }
      return claim(subjectId, key, requestHash, now, attempt + 1);
    }

    return {
      requestHash: existing.requestHash,
      response:
        existing.responseStatus === null
          ? null
          : { status: existing.responseStatus, body: existing.responseBody },
    };
  }

  return {
    claim: (subjectId, key, requestHash, now) => claim(subjectId, key, requestHash, now),

    async complete(subjectId, key, response) {
      await db
        .update(idempotencyKeys)
        .set({ responseStatus: response.status, responseBody: response.body })
        .where(sameKey(subjectId, key));
    },

    async release(subjectId, key) {
      await db.delete(idempotencyKeys).where(sameKey(subjectId, key));
    },

    async deleteExpired(now) {
      const deleted = await db
        .delete(idempotencyKeys)
        .where(lte(idempotencyKeys.expiresAt, now))
        .returning({ id: idempotencyKeys.id });
      return deleted.length;
    },
  };
}
