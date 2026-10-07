// The RateLimitStore (src/http/rate-limit.ts) on the rate_limit_counters table.
//
// One statement does the whole job: insert the counter at 1, or if that
// (key, window_start) row already exists, add 1 to it, and return the new
// count. PostgreSQL runs the update atomically, so two requests arriving at
// the same instant get 1 and 2, never both 1. See docs/backend-notes.md entry 30.

import { lt, sql } from 'drizzle-orm';
import type { RateLimitStore } from '../http/rate-limit.js';
import type { Database } from './idempotency-store.js';
import { rateLimitCounters } from './schema/index.js';

export function createRateLimitStore(db: Database): RateLimitStore {
  return {
    async hit(key, windowStart) {
      const rows = await db
        .insert(rateLimitCounters)
        .values({ key, windowStart, count: 1 })
        .onConflictDoUpdate({
          target: [rateLimitCounters.key, rateLimitCounters.windowStart],
          set: { count: sql`${rateLimitCounters.count} + 1` },
        })
        .returning({ count: rateLimitCounters.count });
      return rows[0]?.count ?? 1;
    },

    async deleteExpired(before) {
      const deleted = await db
        .delete(rateLimitCounters)
        .where(lt(rateLimitCounters.windowStart, before))
        .returning({ key: rateLimitCounters.key });
      return deleted.length;
    },
  };
}
