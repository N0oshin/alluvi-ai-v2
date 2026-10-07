// The outbox publisher: the handler for the 'outbox.publish' job.
//
// A consumer is a function that reacts to one kind of event: "when a meal
// changes, recompute that day's summary". Consumers are registered by event
// type in the worker (src/workers/index.ts), one list per type, as the
// phases that need them arrive. The publisher takes the pending events in
// order and calls every consumer for each one.
//
// Rules a consumer must follow (backend notes entry 24): it may see the same
// event twice, because a crash between "consumers ran" and "marked
// published" replays it, so it must be safe to run again; and it must throw
// on failure, so the event stays pending with the error recorded and the
// next run tries it again.

import type { OutboxEvent, OutboxStore } from '../../db/outbox.js';
import type { JobPayloads } from '../definitions.js';
import type { JobHandler } from '../queue.js';

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
