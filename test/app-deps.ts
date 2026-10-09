// The dependencies buildApp() needs, with fakes that need no database: a
// database check that always succeeds, in-memory idempotency and rate limit
// stores, and a job queue that records jobs without running them. Every HTTP
// test starts from this and overrides what it needs:
//
//   const app = buildApp(fakeDeps());
//   const app = buildApp(fakeDeps({ checkDatabase: () => Promise.reject(new Error('down')) }));

import type { AppDependencies } from '../src/app.js';
import { ephemeralAccessTokenService } from '../src/auth/access-token.js';
import { memoryAccountStore } from '../src/db/account-store.js';
import { memoryDeviceStore } from '../src/db/device-store.js';
import { memoryGuestSessionStore } from '../src/db/guest-session-store.js';
import { memorySessionStore } from '../src/db/session-store.js';
import { memoryIdempotencyStore } from '../src/http/idempotency.js';
import { memoryRateLimitStore } from '../src/http/rate-limit.js';
import type { JobPayloads } from '../src/jobs/definitions.js';
import { memoryJobQueue } from '../src/jobs/queue.js';
import { fakeProviders } from '../src/providers/index.js';

export function fakeDeps(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    checkDatabase: () => Promise.resolve(),
    idempotencyStore: memoryIdempotencyStore(),
    rateLimitStore: memoryRateLimitStore(),
    jobs: memoryJobQueue<JobPayloads>(),
    providers: fakeProviders(),
    accessTokens: ephemeralAccessTokenService(),
    guestSessions: memoryGuestSessionStore(),
    devices: memoryDeviceStore(),
    accounts: memoryAccountStore(),
    sessions: memorySessionStore(),
    ...overrides,
  };
}
