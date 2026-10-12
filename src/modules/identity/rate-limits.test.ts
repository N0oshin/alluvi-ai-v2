// Phase 2.4: every authentication route has rate limits, and they are the
// ones in document 03 section 4.1. Routes are collected as they register
// (Fastify's `onRoute` hook), so a route added later without limits fails
// here instead of shipping open.

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { fakeDeps } from '../../../test/app-deps.js';
import { HOUR, MINUTE, SECOND, type RateLimitRule } from '../../http/rate-limit.js';
import { guestSessionRoutes } from './guest-sessions.js';
import { magicLinkRoutes } from './magic-links.js';
import { sessionRoutes } from './sessions.js';
import { socialSignInRoutes } from './social-sign-in.js';

interface Collected {
  method: string;
  url: string;
  auth: string | undefined;
  rules: RateLimitRule[];
}

async function collectRoutes(): Promise<Collected[]> {
  const deps = fakeDeps();
  const app = Fastify();
  const routes: Collected[] = [];

  // Added before the plugins register, so it also sees their routes.
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const config = route.config as { auth?: string; rateLimits?: RateLimitRule[] } | undefined;
    for (const method of methods) {
      routes.push({
        method,
        url: route.url,
        auth: config?.auth,
        rules: config?.rateLimits ?? [],
      });
    }
  });

  void app.register(guestSessionRoutes(deps), { prefix: '/v1' });
  void app.register(sessionRoutes(deps), { prefix: '/v1' });
  void app.register(magicLinkRoutes({ ...deps, email: deps.providers.email }), { prefix: '/v1' });
  void app.register(socialSignInRoutes(deps), { prefix: '/v1' });
  await app.ready();
  await app.close();

  return routes.filter((route) => route.method !== 'HEAD');
}

// The rule's name, limit and window, without the `keyOf` function.
const shape = (rules: RateLimitRule[]) =>
  rules.map(({ name, limit, windowMs }) => ({ name, limit, windowMs }));

describe('authentication route rate limits', () => {
  it('gives every route a rate limit rule', async () => {
    const routes = await collectRoutes();
    expect(routes.map((r) => r.url).sort()).toEqual([
      '/v1/auth/apple',
      '/v1/auth/email/magic-links',
      '/v1/auth/email/magic-links/consume',
      '/v1/auth/google',
      '/v1/auth/logout',
      '/v1/auth/token/refresh',
      '/v1/guest-sessions',
    ]);
    for (const route of routes) {
      expect(route.rules.length, `${route.method} ${route.url}`).toBeGreaterThan(0);
    }
  });

  it('matches document 03 section 4.1', async () => {
    const routes = await collectRoutes();
    const rulesOf = (url: string) => shape(routes.find((r) => r.url === url)?.rules ?? []);

    expect(rulesOf('/v1/guest-sessions')).toEqual([
      { name: 'guest_sessions.ip', limit: 10, windowMs: HOUR },
      { name: 'guest_sessions.install', limit: 10, windowMs: HOUR },
    ]);
    expect(rulesOf('/v1/auth/email/magic-links')).toEqual([
      { name: 'magic_link.email.cooldown', limit: 1, windowMs: 30 * SECOND },
      { name: 'magic_link.email.hour', limit: 5, windowMs: HOUR },
      { name: 'magic_link.ip', limit: 20, windowMs: HOUR },
    ]);
    expect(rulesOf('/v1/auth/email/magic-links/consume')).toEqual([
      { name: 'magic_link.consume.ip', limit: 10, windowMs: 10 * MINUTE },
    ]);
    expect(rulesOf('/v1/auth/apple')).toEqual([
      { name: 'auth.apple.ip', limit: 20, windowMs: 10 * MINUTE },
    ]);
    expect(rulesOf('/v1/auth/google')).toEqual([
      { name: 'auth.google.ip', limit: 20, windowMs: 10 * MINUTE },
    ]);
  });
});
