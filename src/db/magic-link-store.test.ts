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
import { hashMagicLinkToken, MAGIC_LINK_LIFETIME_MS } from '../auth/magic-link-token.js';
import { createMagicLinkStore, type MagicLinkRequest } from './magic-link-store.js';
import { magicLinkTokens } from './schema/index.js';

const now = new Date('2026-10-09T10:00:00Z');

describeWithDatabase('createMagicLinkStore', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  const store = () => createMagicLinkStore(testDb());

  async function aRequest(): Promise<MagicLinkRequest> {
    const device = await factories.device.create();
    return {
      email: 'hamish@example.com',
      intent: 'sign_up',
      guestSessionId: null,
      requestedDeviceId: device.id,
      requestedIp: '203.0.113.7',
    };
  }

  it('stores only the hash, with a 15 minute expiry', async () => {
    const { link, token } = await store().create(await aRequest(), now);
    expect(token).toMatch(/^mlt_/);
    expect(link.expiresAt.getTime()).toBe(now.getTime() + MAGIC_LINK_LIFETIME_MS);

    const [row] = await testDb()
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, link.id));
    expect(row?.tokenHash).toBe(hashMagicLinkToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('peeks without using up, consumes once, then reports already used', async () => {
    const { token } = await store().create(await aRequest(), now);
    const peeked = await store().peek(token, now);
    expect(peeked.consumedAt).toBeNull();

    const consumed = await store().consume(token, now);
    expect(consumed.consumedAt?.getTime()).toBe(now.getTime());

    await expect(store().peek(token, now)).rejects.toMatchObject({
      code: 'magic_link_already_used',
    });
    await expect(store().consume(token, now)).rejects.toMatchObject({
      code: 'magic_link_already_used',
    });
  });

  it('refuses unknown and expired tokens', async () => {
    await expect(store().consume('mlt_nope', now)).rejects.toMatchObject({
      code: 'magic_link_invalid',
    });
    const { token } = await store().create(await aRequest(), now);
    const late = new Date(now.getTime() + MAGIC_LINK_LIFETIME_MS + 1);
    await expect(store().consume(token, late)).rejects.toMatchObject({
      code: 'magic_link_expired',
    });
  });

  it('lets exactly one of two simultaneous consumes win', async () => {
    const { token } = await store().create(await aRequest(), now);
    const results = await Promise.allSettled([
      store().consume(token, now),
      store().consume(token, now),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('deletes a link whose email failed', async () => {
    const { link, token } = await store().create(await aRequest(), now);
    await store().delete(link.id);
    await expect(store().peek(token, now)).rejects.toMatchObject({ code: 'magic_link_invalid' });
  });
});
