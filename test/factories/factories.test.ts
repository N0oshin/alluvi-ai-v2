import { count } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, idempotencyKeys, outbox } from '../../src/db/schema/index.js';
import {
  allTables,
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  testDb,
  truncateAll,
} from '../db.js';
import { factories } from './index.js';

// `build` needs no database, so these run everywhere.
describe('factories (build)', () => {
  it('fills every required column with a fresh value each time', () => {
    const a = factories.outboxEvent.build();
    const b = factories.outboxEvent.build();
    expect(a.eventType).toBe('meal.changed');
    expect(a.aggregateId).not.toBe(b.aggregateId);
    expect(a.payload).not.toEqual(b.payload);
  });

  it('lets a test override only what it cares about', () => {
    const row = factories.idempotencyKey.build({ responseStatus: null, responseBody: null });
    expect(row.responseStatus).toBeNull();
    expect(row.responseBody).toBeNull();
    expect(row.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('knows every table in the schema barrel', () => {
    expect(allTables).toHaveLength(11);
  });
});

// `create` inserts into the test database. Skipped without TEST_DATABASE_URL.
describeWithDatabase('factories (create)', () => {
  beforeAll(async () => {
    await migrateTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it('inserts a row and returns it with the generated columns filled in', async () => {
    const row = await factories.outboxEvent.create({ eventType: 'badge.earned' });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.eventType).toBe('badge.earned');
    expect(row.publishedAt).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('enforces the unique (subject_id, key) index', async () => {
    const first = await factories.idempotencyKey.create();
    // Drizzle wraps the database error: its own message holds the query, and
    // the PostgreSQL error that names the index is attached as `cause`.
    const error = await factories.idempotencyKey
      .create({ subjectId: first.subjectId, key: first.key })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const cause = (error as Error).cause as { code?: string; constraint?: string };
    expect(cause.code).toBe('23505'); // unique_violation
    expect(cause.constraint).toBe('idempotency_keys_subject_key');
  });

  it('defaults audit_log metadata to an empty object', async () => {
    const row = await factories.auditEntry.create({ metadata: undefined });
    expect(row.metadata).toEqual({});
    expect(row.actorUserId).not.toBeNull();
  });

  it('starts every test from empty tables', async () => {
    await factories.outboxEvent.create();
    await factories.auditEntry.create();
    await factories.idempotencyKey.create();
    await truncateAll();
    for (const table of [outbox, auditLog, idempotencyKeys]) {
      const [row] = await testDb().select({ n: count() }).from(table);
      expect(row?.n).toBe(0);
    }
  });
});
