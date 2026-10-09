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
import { GUEST_TOKEN_LIFETIME_MS, hashGuestToken } from '../auth/guest-token.js';
import { AppError } from '../http/errors.js';
import { createGuestSessionStore } from './guest-session-store.js';
import { guestSessions } from './schema/index.js';

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describeWithDatabase('createGuestSessionStore', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  const now = new Date('2026-10-09T10:00:00Z');
  const store = () => createGuestSessionStore(testDb());

  it('creates a 30 day unclaimed session and stores only the hash of the token', async () => {
    const device = await factories.device.create();
    const { guestSession, guestToken } = await store().create(device.id, now);

    expect(guestToken).toMatch(/^gst_/);
    expect(guestSession.deviceId).toBe(device.id);
    expect(guestSession.claimedByUserId).toBeNull();
    expect(guestSession.expiresAt.getTime()).toBe(now.getTime() + GUEST_TOKEN_LIFETIME_MS);

    const [row] = await testDb()
      .select()
      .from(guestSessions)
      .where(eq(guestSessions.id, guestSession.id));
    expect(row?.tokenHash).toBe(hashGuestToken(guestToken));
    expect(JSON.stringify(row)).not.toContain(guestToken);
  });

  it('resolves a live token to its session', async () => {
    const device = await factories.device.create();
    const issued = await store().create(device.id, now);
    const resolved = await store().resolve(issued.guestToken, now);
    expect(resolved).toEqual(issued.guestSession);
  });

  it('refuses an unknown, an expired and a claimed token with unauthenticated', async () => {
    const device = await factories.device.create();
    expect(await errorCode(store().resolve('gst_never-issued', now))).toBe('unauthenticated');

    const issued = await store().create(device.id, now);
    const afterExpiry = new Date(now.getTime() + GUEST_TOKEN_LIFETIME_MS + 1);
    expect(await errorCode(store().resolve(issued.guestToken, afterExpiry))).toBe(
      'unauthenticated',
    );

    const user = await factories.user.create();
    await store().claim(issued.guestSession.id, user.id, now);
    expect(await errorCode(store().resolve(issued.guestToken, now))).toBe('unauthenticated');
  });

  it('claims a session once; a second claim is a conflict', async () => {
    const device = await factories.device.create();
    const issued = await store().create(device.id, now);
    const first = await factories.user.create();
    const second = await factories.user.create();

    const claimed = await store().claim(issued.guestSession.id, first.id, now);
    expect(claimed.claimedByUserId).toBe(first.id);

    expect(await errorCode(store().claim(issued.guestSession.id, second.id, now))).toBe('conflict');
    expect(await errorCode(store().claim(issued.guestSession.id, first.id, now))).toBe('conflict');
  });

  it('lets exactly one of two simultaneous claims win', async () => {
    const device = await factories.device.create();
    const issued = await store().create(device.id, now);
    const a = await factories.user.create();
    const b = await factories.user.create();

    const results = await Promise.allSettled([
      store().claim(issued.guestSession.id, a.id, now),
      store().claim(issued.guestSession.id, b.id, now),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('refuses to claim an unknown or an expired session', async () => {
    const user = await factories.user.create();
    expect(
      await errorCode(store().claim('019a0000-0000-7000-8000-000000000000', user.id, now)),
    ).toBe('unauthenticated');

    const device = await factories.device.create();
    const issued = await store().create(device.id, now);
    const afterExpiry = new Date(now.getTime() + GUEST_TOKEN_LIFETIME_MS + 1);
    expect(await errorCode(store().claim(issued.guestSession.id, user.id, afterExpiry))).toBe(
      'unauthenticated',
    );
    // The failed claim left the session unclaimed.
    const [row] = await testDb()
      .select()
      .from(guestSessions)
      .where(eq(guestSessions.id, issued.guestSession.id));
    expect(row?.claimedByUserId).toBeNull();
  });
});
