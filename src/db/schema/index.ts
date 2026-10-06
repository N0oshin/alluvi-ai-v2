// Barrel for the Drizzle schema: the one file that lists every table and
// enumeration in the database.
//
// Two readers depend on it. drizzle-kit (drizzle.config.ts) imports it to work
// out which SQL the database needs. The Drizzle client (src/db/index.ts) passes
// it to drizzle() so that queries know every table and the relations between
// them.
//
// One file per bounded context, matching the folders under src/modules/. A
// context's file is added here in the phase that creates its tables:
//
//   shared.ts          column helpers used by every table (Phase 1.4)
//   enums.ts           every enumeration, document 01 section 5 (Phase 1.4)
//   infrastructure.ts  idempotency_keys, audit_log, outbox (Phase 1.4)
//   identity.ts        users, devices, sessions, tokens (Phase 2)
//   onboarding.ts      guest sessions and questionnaire answers (Phase 3)
//   profile.ts / goals.ts                                        (Phase 4)
//   food.ts            media, scans, meals                       (Phase 5)
//   tracking.ts        water, activity, daily summaries          (Phase 6)
//   fasting.ts                                                   (Phase 7)
//   progress.ts        weight, photos, streaks, badges           (Phase 8)
//   groups.ts          groups, membership, chat                  (Phase 9)
//   notifications.ts                                             (Phase 10)
//   reports.ts                                                   (Phase 11)
//
// Only tables and enumerations are exported from here. Column helpers stay in
// shared.ts and are imported by the schema files that use them.

export * from './enums.js';
export * from './infrastructure.js';
