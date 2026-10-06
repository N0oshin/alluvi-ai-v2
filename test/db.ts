// The test database. Tests that touch PostgreSQL use this file and nothing in
// src/db, so they can never run against the development database.
//
// Rules (backend notes, entry 27):
//   - TEST_DATABASE_URL names the database. It must be set explicitly; tests
//     never fall back to DATABASE_URL. Until production exists it is the same
//     Supabase project as development (decided 2026-10-06), which means every
//     `npm test` empties the development tables. A separate project is a
//     Phase 13 launch item.
//   - It is migrated with the real files in src/db/migrations, never with
//     drizzle-kit push, so the tests see exactly what production will.
//   - Every table is truncated before each test. A test starts from nothing and
//     creates what it needs through the factories (test/factories).
//   - When TEST_DATABASE_URL is not set, database tests are skipped, not failed,
//     so the unit tests run without any database.

import { getTableName, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isPgEnum, PgTable } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { describe } from 'vitest';
import { config } from '../src/config/index.js';
import * as schema from '../src/db/schema/index.js';

export const hasTestDatabase = config.TEST_DATABASE_URL !== undefined;

// `describe` for a block of tests that needs the database. Skipped, with the
// block still listed in the output, when there is no test database.
export const describeWithDatabase = hasTestDatabase ? describe : describe.skip;

// The Drizzle client type with this project's schema attached.
export type TestDatabase = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: TestDatabase | undefined;

// Connects on first use, not on import, so importing this file is harmless
// when there is no test database.
export function testDb(): TestDatabase {
  if (db) return db;
  if (config.TEST_DATABASE_URL === undefined) {
    throw new Error('TEST_DATABASE_URL is not set; wrap database tests in describeWithDatabase');
  }
  pool = new Pool({ connectionString: config.TEST_DATABASE_URL, connectionTimeoutMillis: 5000 });
  // Same construction as src/db/index.ts, pointed at the test database.
  db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return db;
}

// Applies any migration not yet applied. Called once per test file, in
// beforeAll. Running it when nothing is pending is cheap.
export async function migrateTestDatabase(): Promise<void> {
  await migrate(testDb(), { migrationsFolder: 'src/db/migrations' });
}

// Every table exported by the schema barrel. Enums are exported too and are
// filtered out; `instanceof PgTable` keeps only tables. The barrel is widened
// to `unknown` values first so the type guard can narrow freely.
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
export async function closeTestDatabase(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}
