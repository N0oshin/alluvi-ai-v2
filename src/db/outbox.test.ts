import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  testDb,
  truncateAll,
} from '../../test/db.js';
import { factories } from '../../test/factories/index.js';
import { addOutboxEvent, createOutboxStore } from './outbox.js';
import { outbox } from './schema/index.js';

describeWithDatabase('outbox store', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  it('inserts an event inside a transaction', async () => {
    await testDb().transaction(async (tx) => {
      await addOutboxEvent(tx, {
        eventType: 'meal.changed',
        aggregateType: 'meal',
        aggregateId: '0199f0a0-0000-7000-8000-000000000001',
        payload: { userId: 'u1' },
      });
    });

    const rows = await testDb().select().from(outbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: 'meal.changed', publishedAt: null, attempts: 0 });
  });

  it('lists pending events oldest first and skips published ones', async () => {
    const store = createOutboxStore(testDb());
    const a = await factories.outboxEvent.create();
    const b = await factories.outboxEvent.create();
    const c = await factories.outboxEvent.create();
    await store.markPublished(b.id, new Date());

    const pending = await store.pending(10);

    expect(pending.map((e) => e.id)).toEqual([a.id, c.id]);
    expect((await store.pending(1)).map((e) => e.id)).toEqual([a.id]);
  });

  it('records a failure without publishing', async () => {
    const store = createOutboxStore(testDb());
    const event = await factories.outboxEvent.create();

    await store.markFailed(event.id, 'consumer threw');
    await store.markFailed(event.id, 'consumer threw again');

    const [row] = await testDb().select().from(outbox);
    expect(row).toMatchObject({
      attempts: 2,
      lastError: 'consumer threw again',
      publishedAt: null,
    });
  });
});
