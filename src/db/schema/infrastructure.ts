// This file defines the schema for the `idempotency_keys`, `audit_log`, `outbox` and `rate_limit_counters` tables, which are used for infrastructure purposes.
//
// The `idempotency_keys` table stores responses for requests that include an
// `Idempotency-Key` header. This allows clients to safely retry requests without
// causing duplicate actions on the server.
//
// The `audit_log` table is an append-only record of security-relevant actions,
// such as sign-ins, failed sign-ins, consent changes, deletion requests, group
// deletions, and moderator actions. It is designed to provide a complete audit
// trail of user and system activity.
//

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, id } from './shared.js';

const instant = () => timestamp({ withTimezone: true });

//Every creating POST sends
// `Idempotency-Key: <uuid>`. The first request stores its response here; a
// replay within 24 hours gets the same response back; a replay with a
// different request is `422 idempotency_key_reused`.
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    ...baseColumns,
    subjectId: uuid().notNull(),
    key: uuid().notNull(),
    requestHash: text().notNull(),
    responseStatus: smallint(),
    responseBody: jsonb(),
    expiresAt: instant().notNull(),
  },
  (table) => [
    uniqueIndex('idempotency_keys_subject_key').on(table.subjectId, table.key),
    index('idempotency_keys_expires_at').on(table.expiresAt),
  ],
);

// A permanent record of the handful of actions that matter if something goes wrong later: a sign-in, a failed sign-in, a consent change, an account deletion request, a group deletion, a moderator action. One row per action with who, when, from which device.
export const auditLog = pgTable(
  'audit_log',
  {
    ...id,
    createdAt: instant().defaultNow().notNull(),
    actorUserId: uuid(),
    action: text().notNull(),
    targetType: text(),
    targetId: uuid(),
    deviceId: uuid(),
    requestId: uuid(),
    // For abuse analysis of failed sign-ins. PostgreSQL's native address type.
    ip: inet(),
    metadata: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    index('audit_log_actor_created').on(table.actorUserId, table.createdAt.desc()),
    index('audit_log_target').on(table.targetType, table.targetId),
  ],
);

// When a meal is saved, other parts of the app need to react: recompute today's totals, update the streak, maybe notify a group. Instead of calling all of them right away, the code writes one small row to the outbox in the same transaction as the meal: "meal.changed, meal id 123". A background worker later reads the pending rows and triggers those reactions, then marks each row as published.
export const outbox = pgTable(
  'outbox',
  {
    ...baseColumns,
    eventType: text().notNull(),
    // The row the event is about: `meal` and its id.
    aggregateType: text().notNull(),
    aggregateId: uuid().notNull(),
    // What consumers need: ids and values, never a whole row.
    payload: jsonb().notNull(),
    // Null until delivered.
    publishedAt: instant(),
    attempts: integer().notNull().default(0),
    lastError: text(),
  },
  (table) => [
    // The publisher polls only the pending rows.
    index('outbox_pending')
      .on(table.id)
      .where(sql`${table.publishedAt} is null`),
  ],
);

// One counter per rate limit rule, per caller, per time window: "magic link
// requests from this email address in the hour starting at 10:00". The hook
// in src/http/rate-limit.ts adds one to the counter on every request and
// refuses the request with 429 once the count passes the rule's limit.
//
// This table has no base columns on purpose: a counter is not an entity with
// an identity and a history. The pair (key, window_start) is the primary key,
// and that is what `insert ... on conflict do update` increments against.
export const rateLimitCounters = pgTable(
  'rate_limit_counters',
  {
    // '<rule name>:<who>', for example 'magic_link.email:ann@example.com'.
    key: text().notNull(),
    windowStart: instant().notNull(),
    count: integer().notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.windowStart] }),
    // The cleanup job deletes windows that have ended.
    index('rate_limit_counters_window_start').on(table.windowStart),
  ],
);

// Addresses we must stop emailing: the email provider told us (through its
// webhook) that mail to them bounced or was reported as spam. One row per
// address, kept up to date with the latest event. Checked before any email
// is sent (decision 39).
export const emailSuppressions = pgTable(
  'email_suppressions',
  {
    ...baseColumns,
    // Lower-cased.
    email: text().notNull(),
    reason: text().notNull(),
    // The provider's id for the event, for tracing in its dashboard.
    providerEventId: text(),
    lastEventAt: instant().notNull(),
  },
  (table) => [
    uniqueIndex('email_suppressions_email').on(table.email),
    check('email_suppressions_reason', sql`${table.reason} in ('bounce', 'complaint')`),
    check('email_suppressions_email_lowercase', sql`${table.email} = lower(${table.email})`),
  ],
);
