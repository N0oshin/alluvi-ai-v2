// The test database.
//
// Rules (backend notes, entry 27):
//   - TEST_DATABASE_URL names it. Under vitest, src/db/index.ts connects
//     there instead of DATABASE_URL, so nothing under test can reach the
//     development database. Until production exists it is the same Supabase
//     project as development (decided 2026-10-06), which means every
//     `npm test` empties the development tables.
//   - It is migrated with the real files in src/db/migrations, never with
//     drizzle-kit push, so the tests see exactly what production will.
//   - Every table is truncated before each test. A test starts from nothing
//     and creates what it needs through the factories (test/factories).
//     Because of that, vitest.config.ts runs test files one at a time.
//   - When TEST_DATABASE_URL is not set, database tests are skipped, not
//     failed, so the unit tests run without any database.
//
// A test file that needs the database:
//
//   describeWithDatabase('...', () => {
//     beforeAll(migrateTestDatabase);
//     beforeEach(truncateAll);
//     afterAll(closeTestDatabase);
//     ...
//   });

import { getTableName, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isPgEnum, PgTable } from 'drizzle-orm/pg-core';
import { describe } from 'vitest';
import { config } from '../src/config/index.js';
import { db, pool, type Database } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';

export const hasTestDatabase = config.NODE_ENV === 'test' && config.TEST_DATABASE_URL !== undefined;

// `describe` for a block of tests that needs the database. Skipped, with the
// block still listed in the output, when there is no test database.
export const describeWithDatabase = hasTestDatabase ? describe : describe.skip;

export type TestDatabase = Database;

// The same client the application code uses.
export function testDb(): Database {
  if (!hasTestDatabase) {
    throw new Error('TEST_DATABASE_URL is not set; wrap database tests in describeWithDatabase');
  }
  return db;
}

// Applies any migration not yet applied. Called once per test file, in
// beforeAll. Running it when nothing is pending is cheap.
export async function migrateTestDatabase(): Promise<void> {
  await migrate(testDb(), { migrationsFolder: 'src/db/migrations' });
}

// Every table exported by the schema. Enums are exported too and are
// filtered out; `instanceof PgTable` keeps only tables.
const exported: unknown[] = Object.values(schema);
export const allTables: PgTable[] = exported.filter(
  (value): value is PgTable => !isPgEnum(value) && value instanceof PgTable,
);

// Empties every table in one statement. CASCADE follows foreign keys, so the
// order of tables does not matter. Called in beforeEach.
export async function truncateAll(): Promise<void> {
  const names = allTables.map((table) => sql.identifier(getTableName(table)));
  await testDb().execute(sql`truncate table ${sql.join(names, sql`, `)} cascade`);
}

// Closes the connections so the test process can exit. Called in afterAll.
// Each test file runs in its own worker, so the pool is this file's alone.
let closed = false;
export async function closeTestDatabase(): Promise<void> {
  if (closed) return;
  closed = true;
  await pool.end();
}
