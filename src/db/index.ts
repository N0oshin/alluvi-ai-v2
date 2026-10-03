// Drizzle client. Shared column helpers are added in Phase 1.4.
//
// `pool` is the raw connection pool from the `pg` driver: it keeps a few
// connections to PostgreSQL open and hands them out per query. `db` is Drizzle
// wrapped around that pool; application code imports `db` and only uses `pool`
// to close the connections on shutdown.

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config } from '../config/index.js';

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  // Give up after 5 seconds if the database cannot be reached, instead of
  // waiting forever. The readiness endpoint relies on this.
  connectionTimeoutMillis: 5000,
});

export const db = drizzle({ client: pool });

// Runs the cheapest possible query. Resolves if the database answers and
// throws if it does not. Used by GET /health/ready.
export async function checkDatabase(): Promise<void> {
  await db.execute(sql`select 1`);
}
