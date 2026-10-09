// The account store: the reads and writes sign-in needs across users,
// auth_identities, user_consents, devices, guest_sessions and sessions.
//
// The sign-in rules (which account an identity belongs to, what next_step
// is, when to refuse) live in src/modules/identity/sign-in.ts and are tested
// without a database against memoryAccountStore(). This file is the SQL, and
// the one thing the SQL must guarantee: creating an account is all or
// nothing. User, identity, consents, device link, guest session claim and the
// first session are written in a single transaction (backend notes, entry 43).

import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createGuestSessionStore } from './guest-session-store.js';
import type { Executor } from './idempotency-store.js';
import type { EnumValue } from './schema/enums.js';
import {
  authIdentities,
  type authProviderEnum,
  type consentTypeEnum,
  devices,
  type userStatusEnum,
  userConsents,
  users,
} from './schema/index.js';
import { createSessionStore, type IssuedSession } from './session-store.js';

export type AuthProvider = EnumValue<typeof authProviderEnum>;
export type ConsentType = EnumValue<typeof consentTypeEnum>;
export type UserStatus = EnumValue<typeof userStatusEnum>;

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

export interface AccountStore {
  // The user behind a provider identity, or undefined if never linked.
  findUserByIdentity(provider: AuthProvider, subject: string): Promise<UserRecord | undefined>;
  // The user with this email, in any letter case.
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  // Which sign-in methods a user has linked.
  providersOf(userId: string): Promise<AuthProvider[]>;
  // A new account. One transaction; throws and writes nothing on any failure.
  createAccount(account: NewAccount, now: Date): Promise<CreatedAccount>;
  // An existing user signing in again: note the identity use, attach the
  // device, claim a guest session if one is given, open a session.
  openSession(
    userId: string,
    identity: { provider: AuthProvider; subject: string },
    deviceId: string,
    guestSessionId: string | null,
    now: Date,
  ): Promise<IssuedSession>;
}

type UserRow = typeof users.$inferSelect;

const toUserRecord = (row: UserRow): UserRecord => ({
  id: row.id,
  email: row.email,
  firstName: row.firstName,
  username: row.username,
  status: row.status,
  onboardingCompletedAt: row.onboardingCompletedAt,
});

export function createAccountStore(db: Executor): AccountStore {
  // attach the phone to the user, then open a session
  async function attachAndOpen(
    tx: Executor,
    userId: string,
    deviceId: string,
    guestSessionId: string | null,
    now: Date,
  ): Promise<IssuedSession> {
    await tx.update(devices).set({ userId, updatedAt: now }).where(eq(devices.id, deviceId));
    if (guestSessionId !== null) {
      await createGuestSessionStore(tx).claim(guestSessionId, userId, now);
    }
    return createSessionStore(tx).create(userId, deviceId, now);
  }

  return {
    async findUserByIdentity(provider, subject) {
      const [row] = await db
        .select({ user: users })
        .from(authIdentities)
        .innerJoin(users, eq(users.id, authIdentities.userId))
        .where(
          sql`${authIdentities.provider} = ${provider} and ${authIdentities.providerSubject} = ${subject}`,
        );
      return row === undefined ? undefined : toUserRecord(row.user);
    },

    async findUserByEmail(email) {
      const row = await db.query.users.findFirst({
        where: sql`lower(${users.email}) = lower(${email})`,
      });
      return row === undefined ? undefined : toUserRecord(row);
    },

    async providersOf(userId) {
      const rows = await db
        .select({ provider: authIdentities.provider })
        .from(authIdentities)
        .where(eq(authIdentities.userId, userId));
      return rows.map((row) => row.provider);
    },

    createAccount(account, now) {
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
    },

    openSession(userId, identity, deviceId, guestSessionId, now) {
      return db.transaction(async (tx) => {
        await tx
          .update(authIdentities)
          .set({ lastUsedAt: now, updatedAt: now })
          .where(
            sql`${authIdentities.provider} = ${identity.provider} and ${authIdentities.providerSubject} = ${identity.subject}`,
          );
        return attachAndOpen(tx, userId, deviceId, guestSessionId, now);
      });
    },
  };
}

// In-memory store with the same contract, for the sign-in service tests.
export interface MemoryAccountStore extends AccountStore {
  readonly users: Map<string, UserRecord>;
  readonly consents: ConsentDecision[];
  readonly claimedGuestSessions: string[];
  // Seeds an existing account for a test.
  addUser(
    user: Partial<UserRecord>,
    identities: { provider: AuthProvider; subject: string }[],
  ): UserRecord;
}

export function memoryAccountStore(): MemoryAccountStore {
  const userMap = new Map<string, UserRecord>();
  const identities: { provider: AuthProvider; subject: string; userId: string }[] = [];
  const consents: ConsentDecision[] = [];
  const claimedGuestSessions: string[] = [];

  const sessionFor = (userId: string, deviceId: string, now: Date): IssuedSession => ({
    session: { id: uuidv7(), userId, deviceId, expiresAt: new Date(now.getTime() + 1) },
    refreshToken: `rft_memory_${uuidv7()}`,
  });

  return {
    users: userMap,
    consents,
    claimedGuestSessions,

    addUser(user, linked) {
      const record: UserRecord = {
        id: uuidv7(),
        email: null,
        firstName: 'Test',
        username: null,
        status: 'active',
        onboardingCompletedAt: null,
        ...user,
      };
      userMap.set(record.id, record);
      for (const identity of linked) identities.push({ ...identity, userId: record.id });
      return record;
    },

    findUserByIdentity(provider, subject) {
      const hit = identities.find((i) => i.provider === provider && i.subject === subject);
      return Promise.resolve(hit === undefined ? undefined : userMap.get(hit.userId));
    },

    findUserByEmail(email) {
      const wanted = email.toLowerCase();
      return Promise.resolve([...userMap.values()].find((u) => u.email?.toLowerCase() === wanted));
    },

    providersOf(userId) {
      return Promise.resolve(identities.filter((i) => i.userId === userId).map((i) => i.provider));
    },

    createAccount(account, now) {
      const record: UserRecord = {
        id: uuidv7(),
        email: account.user.email,
        firstName: account.user.firstName,
        username: null,
        status: 'active',
        onboardingCompletedAt: null,
      };
      userMap.set(record.id, record);
      identities.push({ ...account.identity, userId: record.id });
      consents.push(...account.consents);
      if (account.guestSessionId !== null) claimedGuestSessions.push(account.guestSessionId);
      return Promise.resolve({
        user: record,
        session: sessionFor(record.id, account.deviceId, now),
      });
    },

    openSession(userId, _identity, deviceId, guestSessionId, now) {
      if (guestSessionId !== null) claimedGuestSessions.push(guestSessionId);
      return Promise.resolve(sessionFor(userId, deviceId, now));
    },
  };
}
