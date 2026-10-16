// The Drizzle client.
//
// `pool` is the raw connection pool from the `pg` driver: it keeps a few
// connections to PostgreSQL open and hands them out per query. `db` is Drizzle
// wrapped around that pool. Module code imports `db`; only the two entry
// points use `pool`, to close the connections on shutdown.

import { sql } from 'drizzle-orm';
import { drizzle, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { config } from '../config/index.js';
import * as schema from './schema.js';

// Under vitest NODE_ENV is 'test' and the client points at TEST_DATABASE_URL,
// so code under test can never reach the development database. When that
// variable is unset the database tests are skipped (test/db.ts), and this
// unreachable address makes any query that slips through fail at once.
function connectionString(): string {
  if (config.NODE_ENV !== 'test') return config.DATABASE_URL;
  return config.TEST_DATABASE_URL ?? 'postgresql://unset@127.0.0.1:1/unset';
}

export const pool = new Pool({
  connectionString: connectionString(),
  // Give up after 5 seconds if the database cannot be reached, instead of
  // waiting forever. The readiness endpoint relies on this.
  connectionTimeoutMillis: 5000,
});

// `schema` lets queries refer to tables by name with full types. `casing`
// must match drizzle.config.ts: camelCase properties, snake_case columns.
export const db = drizzle({ client: pool, schema, casing: 'snake_case' });

export type Database = typeof db;

// `db` itself or the handle `db.transaction` gives its callback. A query that
// must be able to run inside a caller's transaction takes one of these.
export type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

// Runs the cheapest possible query. Resolves if the database answers and
// throws if it does not. Used by GET /health/ready.
export async function checkDatabase(): Promise<void> {
  await db.execute(sql`select 1`);
}
