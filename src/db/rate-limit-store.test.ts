import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  testDb,
  truncateAll,
} from '../../test/db.js';
import { factories } from '../../test/factories/index.js';
import { createRateLimitStore } from './rate-limit-store.js';
import { rateLimitCounters } from './schema/index.js';

describeWithDatabase('createRateLimitStore', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  const w1 = new Date('2026-10-07T10:17:00Z');
  const w2 = new Date('2026-10-07T10:18:00Z');

  it('starts a counter at 1 and adds 1 on each hit', async () => {
    const store = createRateLimitStore(testDb());

    expect(await store.hit('ping.ip:10.0.0.1', w1)).toBe(1);
    expect(await store.hit('ping.ip:10.0.0.1', w1)).toBe(2);
    expect(await store.hit('ping.ip:10.0.0.1', w1)).toBe(3);

    const rows = await testDb().select().from(rateLimitCounters);
    expect(rows).toEqual([{ key: 'ping.ip:10.0.0.1', windowStart: w1, count: 3 }]);
  });

  it('keeps keys and windows apart', async () => {
    const store = createRateLimitStore(testDb());
    await store.hit('a', w1);

    expect(await store.hit('b', w1)).toBe(1);
    expect(await store.hit('a', w2)).toBe(1);
  });

  it('continues a counter made by the factory', async () => {
    const store = createRateLimitStore(testDb());
    const row = await factories.rateLimitCounter.create({ count: 7 });

    expect(await store.hit(row.key, row.windowStart)).toBe(8);
  });

  it('counts simultaneous hits exactly', async () => {
    const store = createRateLimitStore(testDb());

    const counts = await Promise.all(
      Array.from({ length: 5 }, () => store.hit('scan.user:u1', w1)),
    );

    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('deletes windows that started before a given time', async () => {
    const store = createRateLimitStore(testDb());
    await store.hit('a', w1);
    await store.hit('a', w2);

    expect(await store.deleteExpired(w2)).toBe(1);
    expect(await testDb().select().from(rateLimitCounters)).toHaveLength(1);
  });
});
