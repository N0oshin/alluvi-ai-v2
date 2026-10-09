import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  testDb,
  truncateAll,
} from '../../test/db.js';
import { factories } from '../../test/factories/index.js';
import { AppError } from '../http/errors.js';
import { createAccountStore, type NewAccount } from './account-store.js';
import { createGuestSessionStore } from './guest-session-store.js';
import {
  authIdentities,
  devices,
  guestSessions,
  sessions,
  userConsents,
  users,
} from './schema/index.js';

const now = new Date('2026-10-09T10:00:00Z');

function newAccount(deviceId: string, guestSessionId: string | null): NewAccount {
  return {
    user: {
      email: 'Hamish@Example.com',
      firstName: 'Hamish',
      lastName: null,
      timeZone: 'Europe/London',
    },
    identity: {
      provider: 'google',
      subject: 'google-sub-1',
      emailAtProvider: 'hamish@example.com',
    },
    consents: [
      { type: 'terms_and_privacy', documentVersion: '2026-09', granted: true },
      { type: 'marketing', documentVersion: '2026-09', granted: false },
    ],
    deviceId,
    guestSessionId,
    ip: '203.0.113.7',
  };
}

describeWithDatabase('createAccountStore', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  const store = () => createAccountStore(testDb());

  it('creates user, identity, consents, device link, guest claim and session together', async () => {
    const device = await factories.device.create();
    const guest = await createGuestSessionStore(testDb()).create(device.id, now);

    const { user, session } = await store().createAccount(
      newAccount(device.id, guest.guestSession.id),
      now,
    );
    expect(user.firstName).toBe('Hamish');
    expect(session.refreshToken).toMatch(/^rft_/);

    const db = testDb();
    expect(await db.select().from(authIdentities)).toHaveLength(1);
    expect(await db.select().from(userConsents)).toHaveLength(2);
    const [sessionRow] = await db.select().from(sessions);
    expect(sessionRow?.userId).toBe(user.id);
    expect(sessionRow?.deviceId).toBe(device.id);
    const [deviceRow] = await db.select().from(devices).where(eq(devices.id, device.id));
    expect(deviceRow?.userId).toBe(user.id);
    const [guestRow] = await db.select().from(guestSessions);
    expect(guestRow?.claimedByUserId).toBe(user.id);
  });

  it('writes nothing when a step fails (the guest session is already claimed)', async () => {
    const device = await factories.device.create();
    const other = await factories.user.create();
    const guest = await createGuestSessionStore(testDb()).create(device.id, now);
    await createGuestSessionStore(testDb()).claim(guest.guestSession.id, other.id, now);

    await expect(
      store().createAccount(newAccount(device.id, guest.guestSession.id), now),
    ).rejects.toBeInstanceOf(AppError);

    const db = testDb();
    // Only the user the test made by hand exists; the rolled back one does not.
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(authIdentities)).toHaveLength(0);
    expect(await db.select().from(userConsents)).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('finds the user by identity and by email in any case, and lists providers', async () => {
    const device = await factories.device.create();
    const { user } = await store().createAccount(newAccount(device.id, null), now);

    expect((await store().findUserByIdentity('google', 'google-sub-1'))?.id).toBe(user.id);
    expect(await store().findUserByIdentity('apple', 'google-sub-1')).toBeUndefined();
    expect((await store().findUserByEmail('HAMISH@example.com'))?.id).toBe(user.id);
    expect(await store().findUserByEmail('nobody@example.com')).toBeUndefined();
    expect(await store().providersOf(user.id)).toEqual(['google']);
  });

  it('opens a session for a returning user and stamps the identity', async () => {
    const device = await factories.device.create();
    const { user } = await store().createAccount(newAccount(device.id, null), now);
    const later = new Date(now.getTime() + 60_000);

    const issued = await store().openSession(
      user.id,
      { provider: 'google', subject: 'google-sub-1' },
      device.id,
      null,
      later,
    );
    expect(issued.session.userId).toBe(user.id);
    expect(await testDb().select().from(sessions)).toHaveLength(2);
    const [identity] = await testDb().select().from(authIdentities);
    expect(identity?.lastUsedAt?.getTime()).toBe(later.getTime());
  });
});
