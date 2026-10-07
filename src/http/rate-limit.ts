// Rate limiting middleware.
//
// A limit says "at most N requests per time window, counted per caller". The
// table in document 03 has a different limit for almost every endpoint, and
// a different idea of "caller" for each (user, IP address, email address,
// session), so the limits are configured per route, not globally:
//
// How a rule works. Time is cut into fixed windows of `windowMs` (for an hour
// window: 10:00 to 11:00, 11:00 to 12:00, ...). Each request adds one to the
// counter for (rule, caller, current window). When the counter goes past
// `limit`, the request is refused with 429 rate_limited and a Retry-After
// header saying how many seconds are left in the window. Refused requests
// still count, so hammering the endpoint does not shorten the wait.
//

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface RateLimitRule {
  // Names the counter, so two rules on different routes never share one.
  name: string;
  // The most requests allowed per window.
  limit: number;
  windowMs: number;
  // Who is making the request, as text; undefined skips the rule.
  keyOf: (request: FastifyRequest) => string | undefined;
}

// The storage behind the hook. src/db/rate-limit-store.ts counts in the
// rate_limit_counters table; memoryRateLimitStore() below is the fake for tests.
export interface RateLimitStore {
  // Adds one to the counter for `key` in the window that starts at
  // `windowStart`, and resolves to the count after adding.
  hit(key: string, windowStart: Date): Promise<number>;
  // Removes the counters of windows that started before `before`. Resolves to how many.
  deleteExpired(before: Date): Promise<number>;
}

export interface RateLimitOptions {
  store: RateLimitStore;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    rateLimits?: RateLimitRule[];
  }
}

// The commonest caller key: the client's IP address. Behind a reverse proxy
// Fastify must be built with `trustProxy` for this to be the real address and
// not the proxy's; that is a deployment setting (Phase 13).
export const byIp = (request: FastifyRequest): string => request.ip;

// The start of the window that contains `now`, for windows of `windowMs`.
export function windowStartOf(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

export function addRateLimiting(app: FastifyInstance, options: RateLimitOptions): void {
  const { store } = options;

  // preHandler, like the idempotency hook, so that `keyOf` can read a parsed
  // body. Registered before idempotency in app.ts, so a refused request never
  // touches the idempotency store.
  app.addHook('preHandler', async (request, reply) => {
    const rules = request.routeOptions.config.rateLimits;
    if (rules === undefined || rules.length === 0) {
      return;
    }

    const now = new Date();
    // The longest wait among the rules that were exceeded, in milliseconds.
    let retryAfterMs = 0;

    for (const rule of rules) {
      const caller = rule.keyOf(request);
      if (caller === undefined) {
        continue;
      }

      const windowStart = windowStartOf(now, rule.windowMs);
      const count = await store.hit(`${rule.name}:${caller}`, windowStart);
      if (count > rule.limit) {
        const windowEnd = windowStart.getTime() + rule.windowMs;
        retryAfterMs = Math.max(retryAfterMs, windowEnd - now.getTime());
      }
    }

    if (retryAfterMs > 0) {
      // Seconds, rounded up so the client never retries a moment too early.
      // The header is set on the reply before throwing; the error handler
      // sends the envelope through the same reply, so the header survives.
      reply.header('Retry-After', String(Math.ceil(retryAfterMs / SECOND)));
      throw new AppError('rate_limited');
    }
  });
}

// In-memory store for tests and for running the app without a database.
export function memoryRateLimitStore(): RateLimitStore {
  const counters = new Map<string, { windowStart: Date; count: number }>();
  const idOf = (key: string, windowStart: Date) => `${key}@${windowStart.getTime()}`;

  return {
    hit(key, windowStart) {
      const id = idOf(key, windowStart);
      const counter = counters.get(id) ?? { windowStart, count: 0 };
      counter.count += 1;
      counters.set(id, counter);
      return Promise.resolve(counter.count);
    },
    deleteExpired(before) {
      let deleted = 0;
      for (const [id, counter] of counters) {
        if (counter.windowStart < before) {
          counters.delete(id);
          deleted += 1;
        }
      }
      return Promise.resolve(deleted);
    },
  };
}
