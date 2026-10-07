//The handler is the part that runs when the worker picks the job up.
//
// The chain for one job:
//
// Someone enqueues infrastructure.cleanup.
// pg-boss stores the row.
// The worker polls, finds it, and calls the handler for that name.
// The handler deletes the expired rows.

import type { IdempotencyStore } from '../../http/idempotency.js';
import type { RateLimitStore } from '../../http/rate-limit.js';
import type { JobPayloads } from '../definitions.js';
import type { JobHandler } from '../queue.js';

export interface InfrastructureHandlerDependencies {
  idempotencyStore: IdempotencyStore;
  rateLimitStore: RateLimitStore;
}

// Deletes idempotency keys past their expiry and rate limit windows that have
// ended. `before` in the payload pins the cutoff for tests; otherwise now.
export function infrastructureCleanup(
  deps: InfrastructureHandlerDependencies,
): JobHandler<JobPayloads['infrastructure.cleanup']> {
  return async (payload, context) => {
    const before = payload.before === undefined ? new Date() : new Date(payload.before);

    const idempotencyKeys = await deps.idempotencyStore.deleteExpired(before);
    const rateLimitWindows = await deps.rateLimitStore.deleteExpired(before);

    context.log.info({ idempotencyKeys, rateLimitWindows }, 'expired rows deleted');
  };
}
