// Factories for the Identity and Access tables (src/db/schema/identity.ts).

import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import {
  authIdentities,
  devices,
  guestSessions,
  magicLinkTokens,
  sessions,
  userConsents,
  users,
} from '../../src/db/schema/index.js';
import { defineFactory, nextSequence } from './define.js';

// An active user who has finished onboarding: the row almost every other
// factory will hang off. Email and username use the sequence so that two
// users made in one test never collide on the unique indexes. `as const` keeps
// the two enum values as exact strings, which the insert type requires.
export const user = defineFactory(users, () => {
  const n = nextSequence();
  return {
    email: `user${n}@example.com`,
    firstName: 'Hamish',
    lastName: 'Grayson',
    username: `hamish_${n}`,
    avatarKind: 'initials' as const,
    avatarColor: 1,
    timeZone: 'Europe/London',
    status: 'active' as const,
    onboardingCompletedAt: new Date(),
  };
});

// A Google sign-in link. `userId` defaults to a random id, which `build` is
// happy with, but the foreign key means `create` needs a real user:
//   const u = await factories.user.create();
//   await factories.authIdentity.create({ userId: u.id });
export const authIdentity = defineFactory(authIdentities, () => {
  const n = nextSequence();
  return {
    userId: uuidv7(),
    provider: 'google' as const,
    providerSubject: `google-sub-${n}`,
    emailAtProvider: `user${n}@example.com`,
    lastUsedAt: new Date(),
  };
});

// An iPhone in guest mode (no user yet) that has granted push permission.
// Pass `userId` to attach it to a user.
export const device = defineFactory(devices, () => ({
  userId: null,
  platform: 'ios' as const,
  pushToken: `fcm-token-${nextSequence()}`,
  pushPermission: 'granted' as const,
  exactAlarmPermission: null,
  appVersion: '26.37.0',
  osVersion: '19.0',
}));

const DAY_MS = 24 * 60 * 60 * 1000;

// A live session, valid for 30 days. Both foreign keys default to random ids,
// so `create` needs a real user and device:
//   await factories.session.create({ userId: u.id, deviceId: d.id });
export const session = defineFactory(sessions, () => ({
  userId: uuidv7(),
  deviceId: uuidv7(),
  refreshTokenHash: createHash('sha256').update(`refresh ${nextSequence()}`).digest('hex'),
  expiresAt: new Date(Date.now() + 30 * DAY_MS),
  revokedAt: null,
}));

// An unclaimed guest session, valid for 30 days. `create` needs a real device:
//   await factories.guestSession.create({ deviceId: d.id });
export const guestSession = defineFactory(guestSessions, () => ({
  deviceId: uuidv7(),
  tokenHash: createHash('sha256').update(`guest ${nextSequence()}`).digest('hex'),
  claimedByUserId: null,
  expiresAt: new Date(Date.now() + 30 * DAY_MS),
}));

const MINUTE_MS = 60 * 1000;

// A fresh, unused sign-in link, valid for 15 minutes, with no guest session.
export const magicLinkToken = defineFactory(magicLinkTokens, () => {
  const n = nextSequence();
  return {
    email: `user${n}@example.com`,
    tokenHash: createHash('sha256').update(`magic ${n}`).digest('hex'),
    intent: 'sign_in' as const,
    guestSessionId: null,
    expiresAt: new Date(Date.now() + 15 * MINUTE_MS),
    consumedAt: null,
    requestedIp: '203.0.113.7',
    requestedDeviceId: uuidv7(),
  };
});

// The required consent, granted. `create` needs a real user:
//   await factories.userConsent.create({ userId: u.id });
export const userConsent = defineFactory(userConsents, () => ({
  userId: uuidv7(),
  consentType: 'terms_and_privacy' as const,
  documentVersion: '2026-09',
  granted: true,
  sourceIp: '203.0.113.7',
}));
