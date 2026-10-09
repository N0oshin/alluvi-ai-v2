import { describe, expect, it } from 'vitest';
import { fakeDeps } from '../../test/app-deps.js';
import { buildApp } from '../app.js';
import { ephemeralAccessTokenService } from '../auth/access-token.js';
import { memoryGuestSessionStore } from '../db/guest-session-store.js';
import { readBearerToken } from './auth.js';
import type { ErrorDetail } from './errors.js';

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

const user = {
  userId: '019a0000-0000-7000-8000-000000000001',
  sessionId: '019a0000-0000-7000-8000-000000000002',
};
const deviceId = '019a0000-0000-7000-8000-000000000003';

// An app with one route per requirement. Each handler answers with the
// principal so the tests can see who the hook decided the caller is.
function buildTestApp(clock: () => Date = () => new Date()) {
  const deps = fakeDeps({
    accessTokens: ephemeralAccessTokenService({ now: clock }),
    guestSessions: memoryGuestSessionStore(),
  });
  const app = buildApp(deps);
  app.get('/public', (request) => request.principal);
  app.get('/user', { config: { auth: 'user' } }, (request) => request.principal);
  app.get('/guest', { config: { auth: 'guest' } }, (request) => request.principal);
  app.get('/either', { config: { auth: 'user_or_guest' } }, (request) => request.principal);
  app.get('/explicit-public', { config: { auth: 'public' } }, (request) => request.principal);
  return { app, deps };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('readBearerToken', () => {
  it('returns the token after Bearer, in any case, and undefined without a header', () => {
    expect(readBearerToken(undefined)).toBeUndefined();
    expect(readBearerToken('Bearer abc')).toBe('abc');
    expect(readBearerToken('bearer abc')).toBe('abc');
    expect(readBearerToken('  Bearer   abc  ')).toBe('abc');
  });

  it('refuses any other shape', () => {
    for (const bad of ['Basic abc', 'Bearer', 'abc', 'Bearer a b', '']) {
      expect(() => readBearerToken(bad)).toThrow(/Sign in/);
    }
  });
});

describe('authentication hook', () => {
  it('treats no header as anonymous: public routes answer, protected ones refuse', async () => {
    const { app } = buildTestApp();
    const open = await app.inject({ method: 'GET', url: '/public' });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ kind: 'anonymous' });

    for (const url of ['/user', '/guest', '/either']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json<ErrorBody>().error.code).toBe('unauthenticated');
    }
  });

  it('turns a valid access token into a user principal', async () => {
    const { app, deps } = buildTestApp();
    const token = await deps.accessTokens.issue(user);

    for (const url of ['/user', '/either', '/public', '/explicit-public']) {
      const response = await app.inject({ method: 'GET', url, headers: bearer(token) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kind: 'user', ...user });
    }
    const guestOnly = await app.inject({ method: 'GET', url: '/guest', headers: bearer(token) });
    expect(guestOnly.statusCode).toBe(401);
  });

  it('turns a valid guest token into a guest principal, scoped to guest routes', async () => {
    const { app, deps } = buildTestApp();
    const { guestSession, guestToken } = await deps.guestSessions.create(deviceId, new Date());

    for (const url of ['/guest', '/either', '/public']) {
      const response = await app.inject({ method: 'GET', url, headers: bearer(guestToken) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kind: 'guest', guestSessionId: guestSession.id, deviceId });
    }
    const userOnly = await app.inject({ method: 'GET', url: '/user', headers: bearer(guestToken) });
    expect(userOnly.statusCode).toBe(401);
    expect(userOnly.json<ErrorBody>().error.code).toBe('unauthenticated');
  });

  it('refuses a bad token everywhere, even on a public route', async () => {
    const { app } = buildTestApp();
    for (const headers of [
      bearer('not-a-jwt'),
      bearer('gst_unknown'),
      { authorization: 'Basic x' },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/public', headers });
      expect(response.statusCode).toBe(401);
      expect(response.json<ErrorBody>().error.code).toBe('unauthenticated');
    }
  });

  it('refuses an expired access token', async () => {
    let clock = new Date('2026-10-09T10:00:00Z');
    const { app, deps } = buildTestApp(() => clock);
    const token = await deps.accessTokens.issue(user);
    clock = new Date('2026-10-09T10:16:00Z');
    const response = await app.inject({ method: 'GET', url: '/user', headers: bearer(token) });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a guest token whose session was claimed', async () => {
    const { app, deps } = buildTestApp();
    const { guestSession, guestToken } = await deps.guestSessions.create(deviceId, new Date());
    await deps.guestSessions.claim(guestSession.id, user.userId, new Date());
    const response = await app.inject({
      method: 'GET',
      url: '/guest',
      headers: bearer(guestToken),
    });
    expect(response.statusCode).toBe(401);
  });
});
