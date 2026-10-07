// Factories for the infrastructure tables (src/db/schema/infrastructure.ts).

import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { auditLog, idempotencyKeys, outbox, rateLimitCounters } from '../../src/db/schema/index.js';
import { defineFactory, nextSequence } from './define.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// A completed first request: status and body already stored, so a replay
// returns them. Pass `responseStatus: null, responseBody: null` for one that
// is still running.
export const idempotencyKey = defineFactory(idempotencyKeys, () => ({
  subjectId: uuidv7(),
  key: uuidv7(),
  requestHash: createHash('sha256').update(`request ${nextSequence()}`).digest('hex'),
  responseStatus: 201,
  responseBody: { id: uuidv7() },
  expiresAt: new Date(Date.now() + DAY_MS),
}));

// A sign-in by a user, the most common entry.
export const auditEntry = defineFactory(auditLog, () => ({
  actorUserId: uuidv7(),
  action: 'auth.sign_in',
  deviceId: uuidv7(),
  requestId: uuidv7(),
  metadata: {},
}));

// A pending event about a meal.
export const outboxEvent = defineFactory(outbox, () => ({
  eventType: 'meal.changed',
  aggregateType: 'meal',
  aggregateId: uuidv7(),
  payload: { sequence: nextSequence() },
}));

// A counter with one hit in the current minute.
export const rateLimitCounter = defineFactory(rateLimitCounters, () => ({
  key: `rule.${nextSequence()}:caller`,
  windowStart: new Date(Math.floor(Date.now() / 60_000) * 60_000),
  count: 1,
}));
