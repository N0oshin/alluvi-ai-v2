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
    expect(link.openedAt).toBeNull();

    const [row] = await testDb()
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, link.id));
    expect(row?.tokenHash).toBe(hashMagicLinkToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('peeks without changing anything, opens once, then consumes once by id', async () => {
    const { link, token } = await store().create(await aRequest(), now);
    const peeked = await store().peek(token, now);
    expect(peeked.openedAt).toBeNull();
    expect(peeked.consumedAt).toBeNull();

    const opened = await store().open(token, now);
    expect(opened.openedAt?.getTime()).toBe(now.getTime());
    // A second confirm keeps the first time.
    const later = new Date(now.getTime() + 5000);
    expect((await store().open(token, later)).openedAt?.getTime()).toBe(now.getTime());

    const found = await store().findById(link.id);
    expect(found?.openedAt?.getTime()).toBe(now.getTime());

    const consumed = await store().consume(link.id, later);
    expect(consumed.consumedAt?.getTime()).toBe(later.getTime());

    await expect(store().peek(token, later)).rejects.toMatchObject({
      code: 'magic_link_already_used',
    });
    await expect(store().open(token, later)).rejects.toMatchObject({
      code: 'magic_link_already_used',
    });
    await expect(store().consume(link.id, later)).rejects.toMatchObject({
      code: 'magic_link_already_used',
    });
  });

  it('refuses unknown and expired links', async () => {
    await expect(store().open('mlt_nope', now)).rejects.toMatchObject({
      code: 'magic_link_invalid',
    });
    expect(await store().findById('00000000-0000-7000-8000-000000000000')).toBeUndefined();
    await expect(
      store().consume('00000000-0000-7000-8000-000000000000', now),
    ).rejects.toMatchObject({ code: 'magic_link_invalid' });

    const { link, token } = await store().create(await aRequest(), now);
    const late = new Date(now.getTime() + MAGIC_LINK_LIFETIME_MS + 1);
    await expect(store().open(token, late)).rejects.toMatchObject({
      code: 'magic_link_expired',
    });
    await expect(store().consume(link.id, late)).rejects.toMatchObject({
      code: 'magic_link_expired',
    });
    // An expired consume must not have marked the row used.
    expect((await store().findById(link.id))?.consumedAt).toBeNull();
  });

  it('lets exactly one of two simultaneous consumes win', async () => {
    const { link } = await store().create(await aRequest(), now);
    const results = await Promise.allSettled([
      store().consume(link.id, now),
      store().consume(link.id, now),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('deletes a link whose email failed', async () => {
    const { link, token } = await store().create(await aRequest(), now);
    await store().delete(link.id);
    await expect(store().peek(token, now)).rejects.toMatchObject({ code: 'magic_link_invalid' });
  });
});
