// The outbox store: the few operations the publisher job and the writers of
// events need on the `outbox` table (docs/backend-notes.md entry 24).
//
// Writing an event: a route that changes a meal inserts the event in the
// same transaction as the meal, so the two commit or roll back together:
//
//   await db.transaction(async (tx) => {
//     await tx.insert(meals).values(...);
//     await addOutboxEvent(tx, { eventType: 'meal.changed', aggregateType: 'meal', aggregateId, payload: { userId, localDate } });
//   });
//
// Reading: the 'outbox.publish' job (src/jobs/handlers/outbox.ts) takes the
// pending rows in id order (UUID v7, so creation order), hands each to its
// consumers, and marks it published or records the failure.

import { asc, eq, isNull, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import type { Database } from './idempotency-store.js';
import { outbox } from './schema/index.js';

export type OutboxEvent = InferSelectModel<typeof outbox>;

export type NewOutboxEvent = Pick<
  InferInsertModel<typeof outbox>,
  'eventType' | 'aggregateType' | 'aggregateId' | 'payload'
>;

// What `db` and a transaction `tx` have in common, so the insert helper
// accepts either.
type Writer = Pick<Database, 'insert'>;

export async function addOutboxEvent(writer: Writer, event: NewOutboxEvent): Promise<void> {
  await writer.insert(outbox).values(event);
}

export interface OutboxStore {
  // The oldest unpublished events, at most `limit` of them.
  pending(limit: number): Promise<OutboxEvent[]>;
  markPublished(id: string, at: Date): Promise<void>;
  // Adds one attempt and keeps the error text; the row stays pending.
  markFailed(id: string, error: string): Promise<void>;
}

export function createOutboxStore(db: Database): OutboxStore {
  return {
    pending(limit) {
      return db
        .select()
        .from(outbox)
        .where(isNull(outbox.publishedAt))
        .orderBy(asc(outbox.id))
        .limit(limit);
    },

    async markPublished(id, at) {
      await db.update(outbox).set({ publishedAt: at }).where(eq(outbox.id, id));
    },

    async markFailed(id, error) {
      await db
        .update(outbox)
        .set({ attempts: sql`${outbox.attempts} + 1`, lastError: error.slice(0, 2000) })
        .where(eq(outbox.id, id));
    },
  };
}

// In-memory store for the publisher's unit tests.
export interface MemoryOutboxStore extends OutboxStore {
  readonly events: OutboxEvent[];
  add(event: NewOutboxEvent): OutboxEvent;
}

export function memoryOutboxStore(): MemoryOutboxStore {
  const events: OutboxEvent[] = [];
  let next = 1;

  return {
    events,
    add(event) {
      const row: OutboxEvent = {
        id: `event-${String(next).padStart(4, '0')}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        publishedAt: null,
        attempts: 0,
        lastError: null,
        ...event,
      };
      next += 1;
      events.push(row);
      return row;
    },
    pending(limit) {
      return Promise.resolve(events.filter((e) => e.publishedAt === null).slice(0, limit));
    },
    markPublished(id, at) {
      const event = events.find((e) => e.id === id);
      if (event) event.publishedAt = at;
      return Promise.resolve();
    },
    markFailed(id, error) {
      const event = events.find((e) => e.id === id);
      if (event) {
        event.attempts += 1;
        event.lastError = error;
      }
      return Promise.resolve();
    },
  };
}
