// This file defines the schema for the `idempotency_keys`, `audit_log` and `outbox` tables, which are used for infrastructure purposes.
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
  index,
  inet,
  integer,
  jsonb,
  pgTable,
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
