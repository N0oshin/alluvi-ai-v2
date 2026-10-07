import { describe, expect, it, vi } from 'vitest';
import { memoryOutboxStore } from '../../db/outbox.js';
import type { JobContext } from '../queue.js';
import { outboxPublish, type OutboxConsumer } from './outbox.js';

function context(aborted = false): JobContext {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    id: 'job-1',
    attempt: 0,
    signal: controller.signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

const mealChanged = { eventType: 'meal.changed', aggregateType: 'meal', aggregateId: 'm1' };

describe('outbox.publish', () => {
  it('hands each pending event to its consumers, in order, and marks it published', async () => {
    const store = memoryOutboxStore();
    const first = store.add({ ...mealChanged, payload: { n: 1 } });
    const second = store.add({ ...mealChanged, payload: { n: 2 } });
    const seen: unknown[] = [];
    const consumer: OutboxConsumer = (event) => {
      seen.push(event.payload);
      return Promise.resolve();
    };

    await outboxPublish({ outbox: store, consumers: { 'meal.changed': [consumer, consumer] } })(
      {},
      context(),
    );

    expect(seen).toEqual([{ n: 1 }, { n: 1 }, { n: 2 }, { n: 2 }]);
    expect(first.publishedAt).toBeInstanceOf(Date);
    expect(second.publishedAt).toBeInstanceOf(Date);
  });

  it('marks an event with no consumer as published', async () => {
    const store = memoryOutboxStore();
    const event = store.add({ ...mealChanged, eventType: 'nobody.cares', payload: {} });

    await outboxPublish({ outbox: store, consumers: {} })({}, context());

    expect(event.publishedAt).toBeInstanceOf(Date);
  });

  it('records a failure and keeps the event pending, then carries on', async () => {
    const store = memoryOutboxStore();
    const bad = store.add({ ...mealChanged, payload: { n: 1 } });
    const good = store.add({ ...mealChanged, payload: { n: 2 } });
    const consumer: OutboxConsumer = (event) =>
      (event.payload as { n: number }).n === 1
        ? Promise.reject(new Error('summary service down'))
        : Promise.resolve();

    await outboxPublish({ outbox: store, consumers: { 'meal.changed': [consumer] } })(
      {},
      context(),
    );

    expect(bad.publishedAt).toBeNull();
    expect(bad.attempts).toBe(1);
    expect(bad.lastError).toBe('summary service down');
    expect(good.publishedAt).toBeInstanceOf(Date);
  });

  it('respects the batch limit', async () => {
    const store = memoryOutboxStore();
    for (let i = 0; i < 5; i += 1) store.add({ ...mealChanged, payload: { i } });

    await outboxPublish({ outbox: store, consumers: {} })({ limit: 2 }, context());

    expect(store.events.filter((e) => e.publishedAt !== null)).toHaveLength(2);
  });

  it('stops early when the worker is shutting down', async () => {
    const store = memoryOutboxStore();
    store.add({ ...mealChanged, payload: {} });

    await outboxPublish({ outbox: store, consumers: {} })({}, context(true));

    expect(store.events[0]?.publishedAt).toBeNull();
  });
});
