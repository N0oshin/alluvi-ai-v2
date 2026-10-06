import { getTableColumns, getTableName } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './index.js';
import { auditLog, idempotencyKeys, outbox } from './infrastructure.js';

// Column names are converted to snake_case at query and migration time, not on
// the column object, so the same converter is used here to see the real names.
const casing = new CasingCache('snake_case');
const columnName = (column: Parameters<CasingCache['getColumnCasing']>[0]) =>
  casing.getColumnCasing(column);

// Index names and the columns they cover, from a table's configuration. An
// index records a lightweight copy of each column, so the real column is looked
// up in the table by its camelCase name before converting.
function indexes(table: Parameters<typeof getTableConfig>[0]) {
  const columns = Object.values(getTableColumns(table));
  return getTableConfig(table).indexes.map((i) => ({
    name: i.config.name,
    unique: i.config.unique,
    where: i.config.where !== undefined,
    columns: i.config.columns.map((c) => {
      const column = 'name' in c ? columns.find((x) => x.name === c.name) : undefined;
      return column ? columnName(column) : 'expression';
    }),
  }));
}

describe('idempotency_keys', () => {
  const columns = getTableColumns(idempotencyKeys);

  it('has the base columns and the request fields', () => {
    expect(getTableName(idempotencyKeys)).toBe('idempotency_keys');
    expect(Object.keys(columns).sort()).toEqual(
      [
        'id',
        'createdAt',
        'updatedAt',
        'subjectId',
        'key',
        'requestHash',
        'responseStatus',
        'responseBody',
        'expiresAt',
      ].sort(),
    );
    expect(columnName(columns.subjectId)).toBe('subject_id');
    expect(columnName(columns.requestHash)).toBe('request_hash');
  });

  it('leaves the response empty while the first request runs', () => {
    expect(columns.responseStatus.notNull).toBe(false);
    expect(columns.responseBody.notNull).toBe(false);
    expect(columns.expiresAt.notNull).toBe(true);
  });

  it('is unique per subject and key, and indexed for cleanup', () => {
    expect(indexes(idempotencyKeys)).toEqual([
      {
        name: 'idempotency_keys_subject_key',
        unique: true,
        where: false,
        columns: ['subject_id', 'key'],
      },
      { name: 'idempotency_keys_expires_at', unique: false, where: false, columns: ['expires_at'] },
    ]);
  });
});

describe('audit_log', () => {
  const columns = getTableColumns(auditLog);

  it('is append-only: no updated_at and no deleted_at', () => {
    expect(getTableName(auditLog)).toBe('audit_log');
    expect(columns).not.toHaveProperty('updatedAt');
    expect(columns).not.toHaveProperty('deletedAt');
    expect(columns.createdAt.hasDefault).toBe(true);
  });

  it('allows an entry without an actor, and requires an action', () => {
    expect(columns.actorUserId.notNull).toBe(false);
    expect(columns.action.notNull).toBe(true);
    expect(columns.metadata.notNull).toBe(true);
    expect(columns.metadata.hasDefault).toBe(true);
  });

  it('is indexed by actor and by target', () => {
    expect(indexes(auditLog).map((i) => i.name)).toEqual([
      'audit_log_actor_created',
      'audit_log_target',
    ]);
  });
});

describe('outbox', () => {
  const columns = getTableColumns(outbox);

  it('describes an event about one aggregate', () => {
    expect(getTableName(outbox)).toBe('outbox');
    expect(columns.eventType.notNull).toBe(true);
    expect(columns.aggregateType.notNull).toBe(true);
    expect(columns.aggregateId.notNull).toBe(true);
    expect(columns.payload.notNull).toBe(true);
  });

  it('starts unpublished with zero attempts', () => {
    expect(columns.publishedAt.notNull).toBe(false);
    expect(columns.attempts.notNull).toBe(true);
    expect(columns.attempts.default).toBe(0);
    expect(columns.lastError.notNull).toBe(false);
  });

  it('has a partial index over the pending rows', () => {
    expect(indexes(outbox)).toEqual([
      { name: 'outbox_pending', unique: false, where: true, columns: ['id'] },
    ]);
  });
});

describe('schema barrel', () => {
  it('exports the three infrastructure tables', () => {
    expect(schema.idempotencyKeys).toBe(idempotencyKeys);
    expect(schema.auditLog).toBe(auditLog);
    expect(schema.outbox).toBe(outbox);
  });
});
