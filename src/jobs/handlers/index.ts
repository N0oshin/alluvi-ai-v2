// The worker polls the database for jobs, and when it finds one it calls the
// handler for that name. A handler receives the job's payload and a context
// with the job's id, the attempt number, a signal that fires when the worker
// is shutting down, and a logger. It runs outside any HTTP request.
//
// Each module exports its handlers from its jobs.ts; this file assembles
// them into the one map the runner takes.

import type { OutboxStore } from '../../db/outbox.js';
import { identityJobs } from '../../modules/identity/index.js';
import { onboardingJobs } from '../../modules/onboarding/index.js';
import type { Providers } from '../../providers/index.js';
import type { IdempotencyStore } from '../../shared/http/idempotency.js';
import type { RateLimitStore } from '../../shared/http/rate-limit.js';
import type { JobPayloads } from '../definitions.js';
import type { JobHandlers } from '../queue.js';
import { infrastructureCleanup } from './infrastructure.js';
import { outboxPublish, type OutboxConsumers } from './outbox.js';

export interface HandlerDependencies {
  idempotencyStore: IdempotencyStore;
  rateLimitStore: RateLimitStore;
  outboxStore: OutboxStore;
  // Event type -> consumers, assembled in the worker as modules add them.
  consumers: OutboxConsumers;
  // Jobs that call a vendor (scan analysis, email, push) take it from here.
  providers: Providers;
}

export function buildHandlers(deps: HandlerDependencies): JobHandlers<JobPayloads> {
  return {
    'infrastructure.cleanup': infrastructureCleanup(deps),
    'outbox.publish': outboxPublish({ outbox: deps.outboxStore, consumers: deps.consumers }),
    ...identityJobs,
    ...onboardingJobs,
  };
}
