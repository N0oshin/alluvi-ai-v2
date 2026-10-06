// drizzle-kit configuration. drizzle-kit is the command-line tool that turns the
// Drizzle schema files in src/db/schema/ into SQL migration files, and applies
// those files to a database. It is not used by the running app; the app only
// uses drizzle-orm. The three commands are in package.json:
//
//   npm run migrate:generate   compare the schema with the last snapshot, write the next SQL file
//   npm run migrate            apply the SQL files that have not been applied yet
//   npm run migrate:check      verify the migration files and snapshots are consistent
//

import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',

  // The one entry point drizzle-kit reads. I
  schema: './src/db/schema/index.ts',

  // Where the generated SQL files and their snapshots are written. Committed.
  out: './src/db/migrations',

  dbCredentials: { url: process.env['DATABASE_URL'] ?? '' },

  // A TypeScript property named `createdAt` becomes the column `created_at`
  casing: 'snake_case',

  // drizzle-kit must only manage the application
  // tables in `public`, or it would try to drop the others.
  schemaFilter: ['public'],

  // Print the SQL as it is applied by `migrate`.
  verbose: true,
  // Ask before a destructive statement (dropping a table or a column).
  strict: true,
});
