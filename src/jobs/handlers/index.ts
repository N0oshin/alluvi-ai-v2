// The worker polls the database for jobs, and when it finds one it calls the handler for that name. The handler is a function that receives the job's payload and a context with the job's id, the attempt number, a signal that fires when the worker is shutting down, and a logger. The handler runs outside any HTTP request, so it can take its time and do whatever it needs to do.

import type { IdempotencyStore } from '../../http/idempotency.js';
import type { RateLimitStore } from '../../http/rate-limit.js';
import type { JobPayloads } from '../definitions.js';
import type { JobHandlers } from '../queue.js';
import { infrastructureCleanup } from './infrastructure.js';

export interface HandlerDependencies {
  idempotencyStore: IdempotencyStore;
  rateLimitStore: RateLimitStore;
}

export function buildHandlers(deps: HandlerDependencies): JobHandlers<JobPayloads> {
  return {
    'infrastructure.cleanup': infrastructureCleanup(deps),
  };
}
