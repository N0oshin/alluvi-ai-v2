import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  testDb,
  truncateAll,
} from '../../test/db.js';
import { factories } from '../../test/factories/index.js';
import { createIdempotencyStore } from './idempotency-store.js';
import { idempotencyKeys } from './schema/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describeWithDatabase('createIdempotencyStore', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  const now = new Date('2026-10-07T10:00:00Z');

  it('claims a new key and records it with a 24 hour expiry', async () => {
    const store = createIdempotencyStore(testDb());
    const subjectId = randomUUID();
    const key = randomUUID();

    expect(await store.claim(subjectId, key, 'hash', now)).toBeNull();

    const rows = await testDb().select().from(idempotencyKeys);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectId, key, requestHash: 'hash', responseStatus: null });
    expect(rows[0]?.expiresAt.getTime()).toBe(now.getTime() + DAY_MS);
  });

  it('returns the record of a claimed key, with its response once completed', async () => {
    const store = createIdempotencyStore(testDb());
    const subjectId = randomUUID();
    const key = randomUUID();
    await store.claim(subjectId, key, 'hash', now);

    expect(await store.claim(subjectId, key, 'hash', now)).toEqual({
      requestHash: 'hash',
      response: null,
    });

    await store.complete(subjectId, key, { status: 201, body: { id: 'meal-1' } });

    expect(await store.claim(subjectId, key, 'other', now)).toEqual({
      requestHash: 'hash',
      response: { status: 201, body: { id: 'meal-1' } },
    });
  });

  it('reads rows made by the factory', async () => {
    const store = createIdempotencyStore(testDb());
    const row = await factories.idempotencyKey.create({ responseStatus: 204, responseBody: null });

    expect(await store.claim(row.subjectId, row.key, row.requestHash, now)).toEqual({
      requestHash: row.requestHash,
      response: { status: 204, body: null },
    });
  });

  it('scopes keys per subject', async () => {
    const store = createIdempotencyStore(testDb());
    const key = randomUUID();

    expect(await store.claim(randomUUID(), key, 'a', now)).toBeNull();
    expect(await store.claim(randomUUID(), key, 'b', now)).toBeNull();
  });

  it('lets exactly one of two simultaneous claims through', async () => {
    const store = createIdempotencyStore(testDb());
    const subjectId = randomUUID();
    const key = randomUUID();

    const results = await Promise.all([
      store.claim(subjectId, key, 'hash', now),
      store.claim(subjectId, key, 'hash', now),
    ]);

    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it('replaces an expired record', async () => {
    const store = createIdempotencyStore(testDb());
    const row = await factories.idempotencyKey.create({ expiresAt: now });

    expect(await store.claim(row.subjectId, row.key, 'fresh', now)).toBeNull();

    const rows = await testDb().select().from(idempotencyKeys);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestHash: 'fresh', responseStatus: null });
  });

  it('releases a claim so the next request runs', async () => {
    const store = createIdempotencyStore(testDb());
    const subjectId = randomUUID();
    const key = randomUUID();
    await store.claim(subjectId, key, 'hash', now);

    await store.release(subjectId, key);

    expect(await store.claim(subjectId, key, 'hash', now)).toBeNull();
  });

  it('deletes expired rows and counts them', async () => {
    const store = createIdempotencyStore(testDb());
    await factories.idempotencyKey.create({ expiresAt: new Date(now.getTime() - 1) });
    await factories.idempotencyKey.create({ expiresAt: now });
    await factories.idempotencyKey.create({ expiresAt: new Date(now.getTime() + 1) });

    expect(await store.deleteExpired(now)).toBe(2);
    expect(await testDb().select().from(idempotencyKeys)).toHaveLength(1);
  });
});
