// Every database call the identity module makes, on its own tables
// (schema.ts), as plain functions over the shared Drizzle client.
//
// Functions that take an `executor` can run inside a caller's transaction.
// `createAccount` opens one of its own: user, identity, consents, device
// link, guest session claim and first session are written all or nothing
// (backend notes, entry 43).

import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/index.js';
import {
  generateGuestToken,
  GUEST_TOKEN_LIFETIME_MS,
  hashGuestToken,
} from '../../shared/auth/guest-token.js';
import {
  generateMagicLinkToken,
  hashMagicLinkToken,
  MAGIC_LINK_LIFETIME_MS,
} from '../../shared/auth/magic-link-token.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_LIFETIME_MS,
} from '../../shared/auth/refresh-token.js';
import { AppError } from '../../shared/http/errors.js';
import type {
  authProviderEnum,
  consentTypeEnum,
  EnumValue,
  magicIntentEnum,
  platformEnum,
  userStatusEnum,
} from '../../shared/schema.js';
import {
  authIdentities,
  devices,
  guestSessions,
  magicLinkTokens,
  sessions,
  userConsents,
  users,
} from './schema.js';

// ---------------------------------------------------------------------------
// Types

export type AuthProvider = EnumValue<typeof authProviderEnum>;
export type ConsentType = EnumValue<typeof consentTypeEnum>;
export type UserStatus = EnumValue<typeof userStatusEnum>;
export type Platform = EnumValue<typeof platformEnum>;
export type MagicIntent = EnumValue<typeof magicIntentEnum>;

// The part of a user row that sign-in reads.
export interface UserRecord {
  id: string;
  email: string | null;
  firstName: string;
  username: string | null;
  status: UserStatus;
  onboardingCompletedAt: Date | null;
}

export interface ConsentDecision {
  type: ConsentType;
  documentVersion: string;
  granted: boolean;
}

export interface Device {
  id: string;
  installId: string;
  platform: Platform;
  // Null while the device is in guest mode.
  userId: string | null;
}

// What the phone tells us about itself.
export interface DeviceRegistration {
  installId: string;
  platform: Platform;
  appVersion: string;
  osVersion: string;
}

export interface Session {
  id: string;
  userId: string;
  deviceId: string;
  expiresAt: Date;
}

// A session plus the one-time chance to see its refresh token in the clear.
export interface IssuedSession {
  session: Session;
  refreshToken: string;
}

export interface GuestSession {
  id: string;
  deviceId: string;
  claimedByUserId: string | null;
  expiresAt: Date;
}

export interface IssuedGuestSession {
  guestSession: GuestSession;
  guestToken: string;
}

export interface MagicLink {
  id: string;
  email: string;
  intent: MagicIntent;
  guestSessionId: string | null;
  requestedDeviceId: string | null;
  expiresAt: Date;
  openedAt: Date | null;
  consumedAt: Date | null;
}

export interface MagicLinkRequest {
  email: string;
  intent: MagicIntent;
  guestSessionId: string | null;
  requestedDeviceId: string;
  requestedIp: string | null;
}

export interface IssuedMagicLink {
  link: MagicLink;
  // The one time the token is seen in the clear; it goes into the email.
  token: string;
}

// Everything needed to create an account in one go.
export interface NewAccount {
  user: { email: string | null; firstName: string; lastName: string | null; timeZone: string };
  identity: { provider: AuthProvider; subject: string; emailAtProvider: string | null };
  consents: ConsentDecision[];
  deviceId: string;
  // The onboarding the person did before signing up, if any.
  guestSessionId: string | null;
  ip: string | null;
}

export interface CreatedAccount {
  user: UserRecord;
  session: IssuedSession;
}

// ---------------------------------------------------------------------------
// Users and accounts

type UserRow = typeof users.$inferSelect;

const toUserRecord = (row: UserRow): UserRecord => ({
  id: row.id,
  email: row.email,
  firstName: row.firstName,
  username: row.username,
  status: row.status,
  onboardingCompletedAt: row.onboardingCompletedAt,
});

// The user behind a provider identity, or undefined if never linked.
export async function findUserByIdentity(
  provider: AuthProvider,
  subject: string,
): Promise<UserRecord | undefined> {
  const [row] = await db
    .select({ user: users })
    .from(authIdentities)
    .innerJoin(users, eq(users.id, authIdentities.userId))
    .where(
      sql`${authIdentities.provider} = ${provider} and ${authIdentities.providerSubject} = ${subject}`,
    );
  return row === undefined ? undefined : toUserRecord(row.user);
}

// The user with this email, in any letter case.
export async function findUserByEmail(email: string): Promise<UserRecord | undefined> {
  const row = await db.query.users.findFirst({
    where: sql`lower(${users.email}) = lower(${email})`,
  });
  return row === undefined ? undefined : toUserRecord(row);
}

// Which sign-in methods a user has linked.
export async function providersOf(userId: string): Promise<AuthProvider[]> {
  const rows = await db
    .select({ provider: authIdentities.provider })
    .from(authIdentities)
    .where(eq(authIdentities.userId, userId));
  return rows.map((row) => row.provider);
}

// Attach the phone to the user, claim the guest session if there is one, open
// a session. The last step of both sign-in paths.
async function attachAndOpen(
  tx: Executor,
  userId: string,
  deviceId: string,
  guestSessionId: string | null,
  now: Date,
): Promise<IssuedSession> {
  await tx.update(devices).set({ userId, updatedAt: now }).where(eq(devices.id, deviceId));
  if (guestSessionId !== null) {
    await claimGuestSession(guestSessionId, userId, now, tx);
  }
  return createSession(userId, deviceId, now, tx);
}

// A new account. One transaction; throws and writes nothing on any failure.
export function createAccount(account: NewAccount, now: Date): Promise<CreatedAccount> {
  return db.transaction(async (tx) => {
    const [userRow] = await tx
      .insert(users)
      .values({
        email: account.user.email,
        firstName: account.user.firstName,
        lastName: account.user.lastName,
        timeZone: account.user.timeZone,
      })
      .returning();
    if (userRow === undefined) throw new Error('user insert returned no row');

    await tx.insert(authIdentities).values({
      userId: userRow.id,
      provider: account.identity.provider,
      providerSubject: account.identity.subject,
      emailAtProvider: account.identity.emailAtProvider,
      lastUsedAt: now,
    });

    if (account.consents.length > 0) {
      await tx.insert(userConsents).values(
        account.consents.map((consent) => ({
          userId: userRow.id,
          consentType: consent.type,
          documentVersion: consent.documentVersion,
          granted: consent.granted,
          sourceIp: account.ip,
        })),
      );
    }

    const session = await attachAndOpen(
      tx,
      userRow.id,
      account.deviceId,
      account.guestSessionId,
      now,
    );
    return { user: toUserRecord(userRow), session };
  });
}

// An existing user signing in again: note the identity use, attach the
// device, claim a guest session if one is given, open a session.
export function openSession(
  userId: string,
  identity: { provider: AuthProvider; subject: string },
  deviceId: string,
  guestSessionId: string | null,
  now: Date,
): Promise<IssuedSession> {
  return db.transaction(async (tx) => {
    await tx
      .update(authIdentities)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(
        sql`${authIdentities.provider} = ${identity.provider} and ${authIdentities.providerSubject} = ${identity.subject}`,
      );
    return attachAndOpen(tx, userId, deviceId, guestSessionId, now);
  });
}

// ---------------------------------------------------------------------------
// Devices
//
// The phone identifies itself with an `install_id` it generated at first
// launch. The first request from an install creates its row; every later one
// finds the row and refreshes the app and OS versions, in one statement.

type DeviceRow = typeof devices.$inferSelect;

const toDevice = (row: DeviceRow): Device => ({
  id: row.id,
  installId: row.installId,
  platform: row.platform,
  userId: row.userId,
});

export async function registerDevice(registration: DeviceRegistration, now: Date): Promise<Device> {
  const [row] = await db
    .insert(devices)
    .values(registration)
    // On conflict, only the version fields change. `userId` and the push
    // fields are left alone: a guest-session request from a signed-in phone
    // must not detach it from its user or forget its push token.
    .onConflictDoUpdate({
      target: devices.installId,
      set: {
        platform: registration.platform,
        appVersion: registration.appVersion,
        osVersion: registration.osVersion,
        updatedAt: now,
      },
    })
    .returning();
  if (row === undefined) throw new Error('device upsert returned no row');
  return toDevice(row);
}

export async function findDeviceByInstallId(installId: string): Promise<Device | undefined> {
  const row = await db.query.devices.findFirst({ where: eq(devices.installId, installId) });
  return row === undefined ? undefined : toDevice(row);
}

// Log out: this phone must stop receiving the user's pushes.
export async function clearPushToken(deviceId: string, now: Date): Promise<void> {
  await db.update(devices).set({ pushToken: null, updatedAt: now }).where(eq(devices.id, deviceId));
}

// ---------------------------------------------------------------------------
// Sessions
//
// Created at sign-in, rotated at refresh, revoked at log out. Each refresh
// replaces the token and keeps the hash of the one it replaced in
// `previous_refresh_token_hash`. If that old token ever comes back, someone
// has a copy they should not have, and the only safe answer is to end the
// session for both of them (backend notes, entry 39).

type SessionRow = typeof sessions.$inferSelect;

const toSession = (row: SessionRow): Session => ({
  id: row.id,
  userId: row.userId,
  deviceId: row.deviceId,
  expiresAt: row.expiresAt,
});

export async function createSession(
  userId: string,
  deviceId: string,
  now: Date,
  executor: Executor = db,
): Promise<IssuedSession> {
  const refreshToken = generateRefreshToken();
  const [row] = await executor
    .insert(sessions)
    .values({
      userId,
      deviceId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
    })
    .returning();
  if (row === undefined) throw new Error('session insert returned no row');
  return { session: toSession(row), refreshToken };
}

// The session behind an access token's `sid`, live or not.
export async function findSession(sessionId: string): Promise<Session | undefined> {
  const row = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  return row === undefined ? undefined : toSession(row);
}

// What the rotation transaction decides; the error is thrown after commit.
type RotationOutcome =
  { kind: 'rotated'; issued: IssuedSession } | { kind: 'reused' } | { kind: 'unknown' };

// Refresh: swap the token for a new one and extend the session. Throws
// unauthenticated for an unknown, expired or revoked token, and
// refresh_token_reused (after revoking the session) for a replay.
export async function rotateSession(refreshToken: string, now: Date): Promise<IssuedSession> {
  const hash = hashRefreshToken(refreshToken);
  const outcome = await db.transaction(async (tx): Promise<RotationOutcome> => {
    // The token could be the row's current one or the one it just replaced.
    const [row] = await tx
      .select()
      .from(sessions)
      .where(or(eq(sessions.refreshTokenHash, hash), eq(sessions.previousRefreshTokenHash, hash)))
      .for('update');

    if (row === undefined || row.revokedAt !== null || row.expiresAt <= now) {
      return { kind: 'unknown' };
    }

    if (row.previousRefreshTokenHash === hash) {
      await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, row.id));
      return { kind: 'reused' };
    }

    const next = generateRefreshToken();
    const [updated] = await tx
      .update(sessions)
      .set({
        refreshTokenHash: hashRefreshToken(next),
        previousRefreshTokenHash: hash,
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
      })
      .where(eq(sessions.id, row.id))
      .returning();
    if (updated === undefined) throw new Error('session update returned no row');
    return { kind: 'rotated', issued: { session: toSession(updated), refreshToken: next } };
  });

  switch (outcome.kind) {
    case 'rotated':
      return outcome.issued;
    case 'reused':
      throw new AppError('refresh_token_reused');
    case 'unknown':
      throw new AppError('unauthenticated');
  }
}

// Log out. Revoking twice is harmless.
export async function revokeSession(sessionId: string, now: Date): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

// Log out everywhere, account deletion, suspension. Returns how many were live.
export async function revokeAllSessionsForUser(userId: string, now: Date): Promise<number> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length;
}

// ---------------------------------------------------------------------------
// Guest sessions
//
// A guest session owns the onboarding answers until an account exists.
// Claiming it hands those answers to the new user and ends the guest token:
// a claimed session no longer resolves, so it cannot be claimed twice.

type GuestSessionRow = typeof guestSessions.$inferSelect;

const toGuestSession = (row: GuestSessionRow): GuestSession => ({
  id: row.id,
  deviceId: row.deviceId,
  claimedByUserId: row.claimedByUserId,
  expiresAt: row.expiresAt,
});

// First launch: a new guest session for this device.
export async function createGuestSession(deviceId: string, now: Date): Promise<IssuedGuestSession> {
  const guestToken = generateGuestToken();
  const [row] = await db
    .insert(guestSessions)
    .values({
      deviceId,
      tokenHash: hashGuestToken(guestToken),
      expiresAt: new Date(now.getTime() + GUEST_TOKEN_LIFETIME_MS),
    })
    .returning();
  if (row === undefined) throw new Error('guest session insert returned no row');
  return { guestSession: toGuestSession(row), guestToken };
}

// Every onboarding request: the live, unclaimed session behind a token.
export async function resolveGuestSession(guestToken: string, now: Date): Promise<GuestSession> {
  const row = await db.query.guestSessions.findFirst({
    where: eq(guestSessions.tokenHash, hashGuestToken(guestToken)),
  });
  if (row === undefined || row.claimedByUserId !== null || row.expiresAt <= now) {
    throw new AppError('unauthenticated');
  }
  return toGuestSession(row);
}

// Sign-in: attach the session to the new user, once.
export async function claimGuestSession(
  guestSessionId: string,
  userId: string,
  now: Date,
  executor: Executor = db,
): Promise<GuestSession> {
  // One statement claims only if still unclaimed, so two sign-ins racing for
  // the same session cannot both win.
  const [claimed] = await executor
    .update(guestSessions)
    .set({ claimedByUserId: userId })
    .where(and(eq(guestSessions.id, guestSessionId), isNull(guestSessions.claimedByUserId)))
    .returning();

  if (claimed !== undefined) {
    // An expired session is put back and refused: a guest who waited more
    // than 30 days starts over.
    if (claimed.expiresAt <= now) {
      await executor
        .update(guestSessions)
        .set({ claimedByUserId: null })
        .where(eq(guestSessions.id, guestSessionId));
      throw new AppError('unauthenticated');
    }
    return toGuestSession(claimed);
  }

  // Nothing matched: either already claimed, or no such session.
  const existing = await executor.query.guestSessions.findFirst({
    where: eq(guestSessions.id, guestSessionId),
  });
  throw new AppError(existing === undefined ? 'unauthenticated' : 'conflict');
}

// Purge job: removes sessions that expired before `before` and were never
// claimed. A claimed session stays: it is the record of where a user's
// onboarding answers came from. Resolves to how many were removed.
export async function deleteExpiredGuestSessions(before: Date): Promise<number> {
  const deleted = await db
    .delete(guestSessions)
    .where(and(lt(guestSessions.expiresAt, before), isNull(guestSessions.claimedByUserId)))
    .returning({ id: guestSessions.id });
  return deleted.length;
}

// ---------------------------------------------------------------------------
// Magic links (decision 51)
//
//   create    when the app asks for the email
//   peek      the browser page looks at the token before showing "confirm"
//   open      the person confirmed on the page: opened_at is set
//   findById  the app polls by the request id it was given
//   consume   the app's claim signs in: consumed_at is set, once
//
// Only the SHA-256 hash of the token is stored. The row's own id doubles as
// the request id the app polls with; it is a UUID v7, so not guessable, and
// the claim route also checks that the polling install is the one that asked.

type MagicLinkRow = typeof magicLinkTokens.$inferSelect;

const toMagicLink = (row: MagicLinkRow): MagicLink => ({
  id: row.id,
  email: row.email,
  intent: row.intent,
  guestSessionId: row.guestSessionId,
  requestedDeviceId: row.requestedDeviceId,
  expiresAt: row.expiresAt,
  openedAt: row.openedAt,
  consumedAt: row.consumedAt,
});

// The three refusals, in the order they are checked.
function assertLive(row: MagicLinkRow | undefined, now: Date): asserts row is MagicLinkRow {
  if (row === undefined) throw new AppError('magic_link_invalid');
  if (row.consumedAt !== null) throw new AppError('magic_link_already_used');
  if (row.expiresAt <= now) throw new AppError('magic_link_expired');
}

const magicLinkByHash = (token: string) =>
  db.query.magicLinkTokens.findFirst({
    where: eq(magicLinkTokens.tokenHash, hashMagicLinkToken(token)),
  });
const magicLinkById = (id: string) =>
  db.query.magicLinkTokens.findFirst({ where: eq(magicLinkTokens.id, id) });

export async function createMagicLink(
  request: MagicLinkRequest,
  now: Date,
): Promise<IssuedMagicLink> {
  const token = generateMagicLinkToken();
  const [row] = await db
    .insert(magicLinkTokens)
    .values({
      email: request.email,
      tokenHash: hashMagicLinkToken(token),
      intent: request.intent,
      guestSessionId: request.guestSessionId,
      requestedDeviceId: request.requestedDeviceId,
      requestedIp: request.requestedIp,
      expiresAt: new Date(now.getTime() + MAGIC_LINK_LIFETIME_MS),
    })
    .returning();
  if (row === undefined) throw new Error('magic link insert returned no row');
  return { link: toMagicLink(row), token };
}

// The live link behind a token, without changing it.
export async function peekMagicLink(token: string, now: Date): Promise<MagicLink> {
  const row = await magicLinkByHash(token);
  assertLive(row, now);
  return toMagicLink(row);
}

// Marks the link opened. Opening an already opened link changes nothing.
export async function openMagicLink(token: string, now: Date): Promise<MagicLink> {
  const row = await magicLinkByHash(token);
  assertLive(row, now);
  if (row.openedAt !== null) return toMagicLink(row);

  // Only the first confirm sets the time; a second one at the same moment
  // loses the race and keeps the first value.
  const [opened] = await db
    .update(magicLinkTokens)
    .set({ openedAt: now })
    .where(and(eq(magicLinkTokens.id, row.id), isNull(magicLinkTokens.openedAt)))
    .returning();
  return toMagicLink(opened ?? { ...row, openedAt: now });
}

export async function findMagicLinkById(id: string): Promise<MagicLink | undefined> {
  const row = await magicLinkById(id);
  return row === undefined ? undefined : toMagicLink(row);
}

// Uses the link up. Throws magic_link_already_used on a second call,
// magic_link_expired when late, magic_link_invalid when the row is gone.
export async function consumeMagicLink(id: string, now: Date): Promise<MagicLink> {
  // One statement marks the link used only if it is live and not used yet,
  // so of two simultaneous claims exactly one gets the row back.
  const [consumed] = await db
    .update(magicLinkTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(magicLinkTokens.id, id),
        isNull(magicLinkTokens.consumedAt),
        gt(magicLinkTokens.expiresAt, now),
      ),
    )
    .returning();

  if (consumed === undefined) {
    // Nothing matched: unknown, used, or expired. assertLive tells which.
    const row = await magicLinkById(id);
    assertLive(row, now);
    // Reached only if the row became live between the two statements, which
    // cannot happen; keeps the type checker satisfied.
    throw new AppError('magic_link_invalid');
  }
  return toMagicLink(consumed);
}

// Undoes a create whose email could not be sent.
export async function deleteMagicLink(linkId: string): Promise<void> {
  await db.delete(magicLinkTokens).where(eq(magicLinkTokens.id, linkId));
}

// Purge job: removes links that expired before `before`, used or not.
export async function deleteExpiredMagicLinks(before: Date): Promise<number> {
  const deleted = await db
    .delete(magicLinkTokens)
    .where(lt(magicLinkTokens.expiresAt, before))
    .returning({ id: magicLinkTokens.id });
  return deleted.length;
}
