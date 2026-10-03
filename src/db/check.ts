// Connection check: runs one query against DATABASE_URL and prints the result.
// Run with `npm run db:check`. Exits with an error if the database cannot be
// reached or rejects the credentials.

import { sql } from 'drizzle-orm';
import { db, pool } from './index.js';

try {
  const result = await db.execute(
    sql`select current_database() as database, current_user as user, version() as version`,
  );
  console.log('database connection ok');
  console.log(result.rows[0]);
} finally {
  // Close the pool so the process can exit.
  await pool.end();
}
