// The dependencies buildApp() needs for a test: a database check that always
// succeeds, in-memory idempotency and rate limit stores, a job queue that
// records jobs without running them, and the fake providers. A test starts
// from this and overrides what it needs:
//
//   const app = buildApp(fakeDeps());
//   const app = buildApp(fakeDeps({ checkDatabase: () => Promise.reject(new Error('down')) }));
//
// Routes that touch the database go to the test database (src/db/index.ts
// picks TEST_DATABASE_URL under vitest), so such tests also need test/db.ts.

import type { AppDependencies } from '../src/app.js';
import type { JobPayloads } from '../src/jobs/definitions.js';
import { memoryJobQueue } from '../src/jobs/queue.js';
import { fakeProviders } from '../src/providers/index.js';
import { memoryIdempotencyStore } from '../src/shared/http/idempotency.js';
import { memoryRateLimitStore } from '../src/shared/http/rate-limit.js';

export function fakeDeps(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    checkDatabase: () => Promise.resolve(),
    idempotencyStore: memoryIdempotencyStore(),
    rateLimitStore: memoryRateLimitStore(),
    jobs: memoryJobQueue<JobPayloads>(),
    providers: fakeProviders(),
    appLinks: {
      appleTeamId: undefined,
      iosBundleId: undefined,
      androidPackageName: undefined,
      androidCertSha256: undefined,
      linkPath: '/groups/',
    },
    ...overrides,
  };
}
