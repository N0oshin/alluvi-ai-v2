import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDeps } from '../../test/app-deps.js';
import { buildApp } from '../app.js';
import type { ErrorDetail } from './errors.js';
import {
  HOUR,
  MINUTE,
  byIp,
  memoryRateLimitStore,
  windowStartOf,
  type RateLimitRule,
  type RateLimitStore,
} from './rate-limit.js';

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

// Builds the app with three routes: one limited per IP, one with two rules
// (per IP and per email in the body), and one with no limit at all.
function buildTestApp(store: RateLimitStore = memoryRateLimitStore()) {
  const app = buildApp(fakeDeps({ rateLimitStore: store }));
  const handler = vi.fn(() => ({ ok: true }));

  const perIp: RateLimitRule = { name: 'ping.ip', limit: 3, windowMs: MINUTE, keyOf: byIp };
  const perEmail: RateLimitRule = {
    name: 'link.email',
    limit: 1,
    windowMs: HOUR,
    keyOf: (request) => {
      const body = request.body as { email?: string } | null;
      return body?.email;
    },
  };

  app.get('/limited', { config: { rateLimits: [perIp] } }, () => handler());
  app.post('/link', { config: { rateLimits: [perIp, perEmail] } }, () => handler());
  app.get('/free', () => handler());

  return { app, handler };
}

describe('windowStartOf', () => {
  it('rounds down to the start of the window', () => {
    expect(windowStartOf(new Date('2026-10-07T10:17:42Z'), MINUTE)).toEqual(
      new Date('2026-10-07T10:17:00Z'),
    );
    expect(windowStartOf(new Date('2026-10-07T10:17:42Z'), HOUR)).toEqual(
      new Date('2026-10-07T10:00:00Z'),
    );
  });
});

describe('rate limited routes', () => {
  beforeEach(() => {
    // Only the clock is faked. Faking setImmediate and friends as well would
    // stall Fastify's body parsing.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T10:17:42Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests up to the limit and refuses the next with Retry-After', async () => {
    const { app, handler } = buildTestApp();

    for (let i = 0; i < 3; i += 1) {
      const ok = await app.inject({ method: 'GET', url: '/limited' });
      expect(ok.statusCode).toBe(200);
    }
    const refused = await app.inject({ method: 'GET', url: '/limited' });

    expect(refused.statusCode).toBe(429);
    expect(refused.json<ErrorBody>().error.code).toBe('rate_limited');
    // 10:17:42 in a one minute window: 18 seconds until 10:18:00.
    expect(refused.headers['retry-after']).toBe('18');
    expect(handler).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it('counts refused requests too, so the wait does not shrink', async () => {
    const { app } = buildTestApp();

    for (let i = 0; i < 5; i += 1) {
      await app.inject({ method: 'GET', url: '/limited' });
    }
    vi.setSystemTime(new Date('2026-10-07T10:17:50Z'));
    const refused = await app.inject({ method: 'GET', url: '/limited' });

    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('10');
    await app.close();
  });

  it('starts afresh in the next window', async () => {
    const { app, handler } = buildTestApp();

    for (let i = 0; i < 4; i += 1) {
      await app.inject({ method: 'GET', url: '/limited' });
    }
    vi.setSystemTime(new Date('2026-10-07T10:18:00Z'));
    const next = await app.inject({ method: 'GET', url: '/limited' });

    expect(next.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(4);
    await app.close();
  });

  it('counts each caller separately', async () => {
    const { app, handler } = buildTestApp();

    for (let i = 0; i < 3; i += 1) {
      await app.inject({ method: 'GET', url: '/limited', remoteAddress: '10.0.0.1' });
    }
    const other = await app.inject({ method: 'GET', url: '/limited', remoteAddress: '10.0.0.2' });
    const same = await app.inject({ method: 'GET', url: '/limited', remoteAddress: '10.0.0.1' });

    expect(other.statusCode).toBe(200);
    expect(same.statusCode).toBe(429);
    expect(handler).toHaveBeenCalledTimes(4);
    await app.close();
  });

  it('applies every rule on a route and reports the longest wait', async () => {
    const { app } = buildTestApp();
    const send = (email: string) =>
      app.inject({ method: 'POST', url: '/link', payload: { email } });

    expect((await send('ann@example.com')).statusCode).toBe(200);
    // Second request for the same address: over the one-per-hour email rule
    // while still under the per-IP rule.
    const refused = await send('ann@example.com');
    expect(refused.statusCode).toBe(429);
    // 10:17:42 in an hour window: 42 minutes 18 seconds = 2538 seconds.
    expect(refused.headers['retry-after']).toBe('2538');
    // A different address is fine.
    expect((await send('bob@example.com')).statusCode).toBe(200);
    await app.close();
  });

  it('skips a rule whose key is absent', async () => {
    const { app } = buildTestApp();

    const first = await app.inject({ method: 'POST', url: '/link', payload: {} });
    const second = await app.inject({ method: 'POST', url: '/link', payload: {} });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    await app.close();
  });

  it('leaves routes without rules alone', async () => {
    const { app } = buildTestApp();

    for (let i = 0; i < 10; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/free' });
      expect(response.statusCode).toBe(200);
    }
    await app.close();
  });

  it('rounds Retry-After up to whole seconds', async () => {
    vi.setSystemTime(new Date('2026-10-07T10:17:59.200Z'));
    const { app } = buildTestApp();

    for (let i = 0; i < 4; i += 1) {
      await app.inject({ method: 'GET', url: '/limited' });
    }
    const refused = await app.inject({ method: 'GET', url: '/limited' });

    expect(refused.headers['retry-after']).toBe('1');
    await app.close();
  });
});

describe('memoryRateLimitStore', () => {
  it('counts per key and window', async () => {
    const store = memoryRateLimitStore();
    const w1 = new Date('2026-10-07T10:17:00Z');
    const w2 = new Date('2026-10-07T10:18:00Z');

    expect(await store.hit('a', w1)).toBe(1);
    expect(await store.hit('a', w1)).toBe(2);
    expect(await store.hit('b', w1)).toBe(1);
    expect(await store.hit('a', w2)).toBe(1);
  });

  it('deletes windows that started before a given time', async () => {
    const store = memoryRateLimitStore();
    const w1 = new Date('2026-10-07T10:17:00Z');
    const w2 = new Date('2026-10-07T10:18:00Z');
    await store.hit('a', w1);
    await store.hit('a', w2);

    expect(await store.deleteExpired(w2)).toBe(1);
    expect(await store.hit('a', w2)).toBe(2);
  });
});
