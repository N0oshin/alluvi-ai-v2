// The one file that lists every table and enumeration in the database.
//
// Two readers depend on it. drizzle-kit (drizzle.config.ts) imports it to
// work out which SQL the database needs. The Drizzle client (src/db/index.ts)
// passes it to drizzle() so that queries know every table.
//
// Each module owns its tables in its own schema.ts; a module's file is added
// here when its tables are created.

export * from '../shared/schema.js';
export * from '../shared/infrastructure/schema.js';
export * from '../modules/identity/schema.js';
export * from '../modules/email/schema.js';
export * from '../modules/onboarding/schema.js';
