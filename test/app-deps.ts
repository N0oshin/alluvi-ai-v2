// The dependencies buildApp() needs, with fakes that need no database: a
// database check that always succeeds, and in-memory idempotency and rate
// limit stores. Every HTTP test starts from this and overrides what it needs:
//
//   const app = buildApp(fakeDeps());
//   const app = buildApp(fakeDeps({ checkDatabase: () => Promise.reject(new Error('down')) }));

import type { AppDependencies } from '../src/app.js';
import { memoryIdempotencyStore } from '../src/http/idempotency.js';
import { memoryRateLimitStore } from '../src/http/rate-limit.js';

export function fakeDeps(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    checkDatabase: () => Promise.resolve(),
    idempotencyStore: memoryIdempotencyStore(),
    rateLimitStore: memoryRateLimitStore(),
    ...overrides,
  };
}
