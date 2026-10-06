import { getTableColumns } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { baseColumns, softDelete } from './shared.js';

// A throwaway table that uses every helper, built the way real tables will be.
const sample = pgTable('sample', {
  ...baseColumns,
  ...softDelete,
  name: text().notNull(),
});

const columns = getTableColumns(sample);

// RFC 9562 layout: the third group starts with the version digit (7) and the
// fourth group starts with the variant (8, 9, a or b).
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('id', () => {
  it('is the primary key with no database default', () => {
    expect(columns.id.primary).toBe(true);
    expect(columns.id.notNull).toBe(true);
    expect(columns.id.hasDefault).toBe(true);
    expect(columns.id.default).toBeUndefined();
  });

  it('generates a UUID v7 in Node', () => {
    const value = columns.id.defaultFn?.();
    expect(value).toMatch(UUID_V7);
  });

  it('generates ids that sort in creation order', () => {
    const ids = Array.from({ length: 50 }, () => columns.id.defaultFn?.() as string);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('timestamps', () => {
  it('maps to snake_case timestamptz columns', () => {
    expect(columns.createdAt.getSQLType()).toBe('timestamp with time zone');
    expect(columns.updatedAt.getSQLType()).toBe('timestamp with time zone');
    expect(columns.deletedAt.getSQLType()).toBe('timestamp with time zone');
  });

  it('created_at and updated_at are set by the database and required', () => {
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.createdAt.hasDefault).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
    expect(columns.updatedAt.hasDefault).toBe(true);
  });

  it('updated_at is refreshed by Drizzle on update, created_at is not', () => {
    expect(columns.updatedAt.onUpdateFn?.()).toBeInstanceOf(Date);
    expect(columns.createdAt.onUpdateFn).toBeUndefined();
  });

  it('deleted_at is optional with no default', () => {
    expect(columns.deletedAt.notNull).toBe(false);
    expect(columns.deletedAt.hasDefault).toBe(false);
  });
});
