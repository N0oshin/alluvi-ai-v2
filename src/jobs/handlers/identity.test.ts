import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryGuestSessionStore } from '../../db/guest-session-store.js';
import { memoryMagicLinkStore } from '../../db/magic-link-store.js';
import type { JobContext } from '../queue.js';
import { identityPurge } from './identity.js';

const info = vi.fn();
const context: JobContext = {
  id: 'job-1',
  attempt: 0,
  signal: new AbortController().signal,
  log: { info, warn: vi.fn(), error: vi.fn() },
};

const DAY = 24 * 60 * 60 * 1000;
const start = new Date('2026-10-01T10:00:00Z');
const device = '019a0000-0000-7000-8000-000000000003';
const user = '019a0000-0000-7000-8000-000000000001';
const linkRequest = {
  email: 'a@example.com',
  intent: 'sign_in' as const,
  guestSessionId: null,
  requestedDeviceId: device,
  requestedIp: null,
};

function setup() {
  const magicLinkStore = memoryMagicLinkStore();
  const guestSessionStore = memoryGuestSessionStore();
  const handler = identityPurge({ magicLinkStore, guestSessionStore });
  return { magicLinkStore, guestSessionStore, handler };
}

describe('identity.purge', () => {
  beforeEach(() => info.mockClear());

  it('deletes magic links a day after they expired, and only those', async () => {
    const { magicLinkStore, handler } = setup();
    const old = await magicLinkStore.create(linkRequest, start);
    const recent = await magicLinkStore.create(linkRequest, new Date(start.getTime() + 2 * DAY));

    const runAt = new Date(start.getTime() + 2 * DAY + 60_000);
    await handler({ before: runAt.toISOString() }, context);

    expect(info).toHaveBeenCalledWith(
      { magicLinks: 1, guestSessions: 0 },
      'expired identity rows deleted',
    );
    await expect(magicLinkStore.peek(old.token, runAt)).rejects.toMatchObject({
      code: 'magic_link_invalid',
    });
    await expect(magicLinkStore.peek(recent.token, runAt)).resolves.toMatchObject({
      id: recent.link.id,
    });
  });

  it('keeps a link that expired less than a day ago, so the person is told it expired', async () => {
    const { magicLinkStore, handler } = setup();
    const issued = await magicLinkStore.create(linkRequest, start);

    const runAt = new Date(start.getTime() + 60 * 60 * 1000);
    await handler({ before: runAt.toISOString() }, context);

    await expect(magicLinkStore.peek(issued.token, runAt)).rejects.toMatchObject({
      code: 'magic_link_expired',
    });
  });

  it('deletes expired guest sessions that were never claimed, and keeps claimed ones', async () => {
    const { guestSessionStore, handler } = setup();
    const abandoned = await guestSessionStore.create(device, start);
    const claimed = await guestSessionStore.create(device, start);
    await guestSessionStore.claim(claimed.guestSession.id, user, start);
    const live = await guestSessionStore.create(device, new Date(start.getTime() + 40 * DAY));

    // 40 days on, the first two (30 day lifetime) have expired.
    const runAt = new Date(start.getTime() + 40 * DAY);
    await handler({ before: runAt.toISOString() }, context);

    expect(info).toHaveBeenCalledWith(
      { magicLinks: 0, guestSessions: 1 },
      'expired identity rows deleted',
    );
    // Gone: claiming it now finds nothing.
    await expect(
      guestSessionStore.claim(abandoned.guestSession.id, user, runAt),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    // Still there: claiming it again is a conflict, not a miss.
    await expect(
      guestSessionStore.claim(claimed.guestSession.id, user, start),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(guestSessionStore.resolve(live.guestToken, runAt)).resolves.toBeDefined();
  });
});
