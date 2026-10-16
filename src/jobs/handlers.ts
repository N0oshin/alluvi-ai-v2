// The handler map the runner takes: job name -> the function that runs it.
//
// The worker polls the database for jobs, and when it finds one it calls the
// handler for that name. A handler receives the job's payload and a context
// with the job's id, the attempt number, a signal that fires when the worker
// is shutting down, and a logger. It runs outside any HTTP request.
//
// Each module exports its handlers from its jobs.ts; the two infrastructure
// jobs live here because they belong to no module.

import { identityJobs } from '../modules/identity/index.js';
import { onboardingJobs } from '../modules/onboarding/index.js';
import type { Providers } from '../providers/index.js';
import type { IdempotencyStore } from '../shared/http/idempotency.js';
import type { RateLimitStore } from '../shared/http/rate-limit.js';
import type { OutboxEvent, OutboxStore } from '../shared/infrastructure/outbox.js';
import type { JobPayloads } from './definitions.js';
import type { JobHandler, JobHandlers } from './queue.js';

// ---------------------------------------------------------------------------
// infrastructure.cleanup: deletes idempotency keys past their expiry and rate
// limit windows that have ended. `before` in the payload pins the cutoff for
// tests; otherwise now.

export interface InfrastructureHandlerDependencies {
  idempotencyStore: IdempotencyStore;
  rateLimitStore: RateLimitStore;
}

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

// ---------------------------------------------------------------------------
// outbox.publish: the outbox publisher.
//
// A consumer is a function that reacts to one kind of event: "when a meal
// changes, recompute that day's summary". Consumers are registered by event
// type in the worker, one list per type, as the modules that need them
// arrive. The publisher takes the pending events in order and calls every
// consumer for each one.
//
// Rules a consumer must follow (backend notes entry 24): it may see the same
// event twice, because a crash between "consumers ran" and "marked
// published" replays it, so it must be safe to run again; and it must throw
// on failure, so the event stays pending with the error recorded and the
// next run tries it again.

export type OutboxConsumer = (event: OutboxEvent) => Promise<void>;

// Event type -> the consumers for it. `Partial` because most types a
// consumer file might name have no consumer yet.
export type OutboxConsumers = Partial<Record<string, OutboxConsumer[]>>;

export interface OutboxHandlerDependencies {
  outbox: OutboxStore;
  consumers: OutboxConsumers;
}

export const DEFAULT_OUTBOX_BATCH = 100;

export function outboxPublish(
  deps: OutboxHandlerDependencies,
): JobHandler<JobPayloads['outbox.publish']> {
  return async (payload, context) => {
    const events = await deps.outbox.pending(payload.limit ?? DEFAULT_OUTBOX_BATCH);
    let published = 0;
    let failed = 0;

    for (const event of events) {
      // The worker is shutting down: leave the rest for the next run.
      if (context.signal.aborted) {
        break;
      }

      const consumers = deps.consumers[event.eventType] ?? [];
      try {
        for (const consume of consumers) {
          await consume(event);
        }
        await deps.outbox.markPublished(event.id, new Date());
        published += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.outbox.markFailed(event.id, message);
        context.log.warn(
          { eventId: event.id, eventType: event.eventType, err: error },
          'outbox event failed',
        );
        failed += 1;
      }
    }

    if (events.length > 0) {
      context.log.info({ published, failed }, 'outbox drained');
    }
  };
}

// ---------------------------------------------------------------------------
// Everything together.

export interface HandlerDependencies extends InfrastructureHandlerDependencies {
  outboxStore: OutboxStore;
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
