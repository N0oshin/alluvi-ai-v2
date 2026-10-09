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
import { hashRefreshToken, REFRESH_TOKEN_LIFETIME_MS } from '../auth/refresh-token.js';
import { AppError } from '../http/errors.js';
import { sessions } from './schema/index.js';
import { createSessionStore } from './session-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describeWithDatabase('createSessionStore', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  const now = new Date('2026-10-09T10:00:00Z');

  async function signedInDevice() {
    const user = await factories.user.create();
    const device = await factories.device.create({ userId: user.id });
    return { user, device, store: createSessionStore(testDb()) };
  }

  it('creates a 60 day session and stores only the hash of the token', async () => {
    const { user, device, store } = await signedInDevice();
    const { session, refreshToken } = await store.create(user.id, device.id, now);

    expect(refreshToken).toMatch(/^rft_/);
    expect(session.userId).toBe(user.id);
    expect(session.deviceId).toBe(device.id);
    expect(session.expiresAt.getTime()).toBe(now.getTime() + REFRESH_TOKEN_LIFETIME_MS);

    const [row] = await testDb().select().from(sessions).where(eq(sessions.id, session.id));
    expect(row?.refreshTokenHash).toBe(hashRefreshToken(refreshToken));
    expect(row?.previousRefreshTokenHash).toBeNull();
    expect(JSON.stringify(row)).not.toContain(refreshToken);
  });

  it('rotates: a new token works, the old one is remembered, the expiry slides', async () => {
    const { user, device, store } = await signedInDevice();
    const first = await store.create(user.id, device.id, now);

    const later = new Date(now.getTime() + 10 * DAY_MS);
    const second = await store.rotate(first.refreshToken, later);

    expect(second.session.id).toBe(first.session.id);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.session.expiresAt.getTime()).toBe(later.getTime() + REFRESH_TOKEN_LIFETIME_MS);

    const [row] = await testDb().select().from(sessions).where(eq(sessions.id, first.session.id));
    expect(row?.refreshTokenHash).toBe(hashRefreshToken(second.refreshToken));
    expect(row?.previousRefreshTokenHash).toBe(hashRefreshToken(first.refreshToken));

    // The new token rotates again; the chain continues.
    const third = await store.rotate(second.refreshToken, later);
    expect(third.refreshToken).not.toBe(second.refreshToken);
  });

  it('treats a rotated-out token as reuse: revokes the session and refuses everything after', async () => {
    const { user, device, store } = await signedInDevice();
    const first = await store.create(user.id, device.id, now);
    const second = await store.rotate(first.refreshToken, now);

    // The old token comes back.
    expect(await errorCode(store.rotate(first.refreshToken, now))).toBe('refresh_token_reused');

    const [row] = await testDb().select().from(sessions).where(eq(sessions.id, first.session.id));
    expect(row?.revokedAt).toEqual(now);

    // The current token is dead too: the whole session went.
    expect(await errorCode(store.rotate(second.refreshToken, now))).toBe('unauthenticated');
  });

  it('refuses an unknown, an expired and a revoked token with unauthenticated', async () => {
    const { user, device, store } = await signedInDevice();
    expect(await errorCode(store.rotate('rft_never-issued', now))).toBe('unauthenticated');

    const issued = await store.create(user.id, device.id, now);
    const afterExpiry = new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS + 1);
    expect(await errorCode(store.rotate(issued.refreshToken, afterExpiry))).toBe('unauthenticated');

    const other = await store.create(user.id, device.id, now);
    await store.revoke(other.session.id, now);
    expect(await errorCode(store.rotate(other.refreshToken, now))).toBe('unauthenticated');
  });

  it('lets exactly one of two simultaneous refreshes through', async () => {
    const { user, device, store } = await signedInDevice();
    const issued = await store.create(user.id, device.id, now);

    const results = await Promise.allSettled([
      store.rotate(issued.refreshToken, now),
      store.rotate(issued.refreshToken, now),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser saw the already-rotated row: its token is now the previous one.
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'refresh_token_reused',
    });
  });

  it('revokes one session, or every live session of a user, and counts them', async () => {
    const { user, device, store } = await signedInDevice();
    const a = await store.create(user.id, device.id, now);
    const b = await store.create(user.id, device.id, now);
    const c = await store.create(user.id, device.id, now);
    await store.revoke(a.session.id, now);
    await store.revoke(a.session.id, now);

    expect(await store.revokeAllForUser(user.id, now)).toBe(2);
    expect(await store.revokeAllForUser(user.id, now)).toBe(0);
    for (const issued of [a, b, c]) {
      expect(await errorCode(store.rotate(issued.refreshToken, now))).toBe('unauthenticated');
    }
  });
});
