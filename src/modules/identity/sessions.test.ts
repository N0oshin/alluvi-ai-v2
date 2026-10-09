import { describe, expect, it } from 'vitest';
import { fakeDeps } from '../../../test/app-deps.js';
import { buildApp } from '../../app.js';
import type { ErrorDetail } from '../../http/errors.js';

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

interface RefreshBody {
  access_token: string;
  access_expires_in: number;
  refresh_token: string;
}

const userId = '019a0000-0000-7000-8000-000000000001';
const deviceId = '019a0000-0000-7000-8000-000000000003';

// An app with a signed-in session already in the store, as sign-in would
// leave it.
async function signedIn() {
  const deps = fakeDeps();
  const app = buildApp(deps);
  const issued = await deps.sessions.create(userId, deviceId, new Date());
  const accessToken = await deps.accessTokens.issue({ userId, sessionId: issued.session.id });
  return { deps, app, issued, accessToken };
}

function refresh(app: ReturnType<typeof buildApp>, refreshToken: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/token/refresh',
    payload: { refresh_token: refreshToken },
  });
}

describe('POST /v1/auth/token/refresh', () => {
  it('trades a live refresh token for a new access token and a new refresh token', async () => {
    const { app, issued, deps } = await signedIn();
    const response = await refresh(app, issued.refreshToken);
    expect(response.statusCode).toBe(200);

    const body = response.json<RefreshBody>();
    expect(body.access_expires_in).toBe(900);
    expect(body.refresh_token).toMatch(/^rft_/);
    expect(body.refresh_token).not.toBe(issued.refreshToken);

    // The new access token names the same user and session.
    const claims = await deps.accessTokens.verify(body.access_token);
    expect(claims).toEqual({ userId, sessionId: issued.session.id });
  });

  it('refuses the old token after rotation and ends the session', async () => {
    const { app, issued } = await signedIn();
    const first = await refresh(app, issued.refreshToken);
    const rotated = first.json<RefreshBody>().refresh_token;

    const replay = await refresh(app, issued.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json<ErrorBody>().error.code).toBe('refresh_token_reused');

    // The legitimate holder is signed out too.
    const after = await refresh(app, rotated);
    expect(after.statusCode).toBe(401);
    expect(after.json<ErrorBody>().error.code).toBe('unauthenticated');
  });

  it('refuses an unknown token and a malformed body', async () => {
    const { app } = await signedIn();
    const unknown = await refresh(app, 'rft_never-issued');
    expect(unknown.statusCode).toBe(401);

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/auth/token/refresh',
      payload: {},
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json<ErrorBody>().error.details[0]?.field).toBe('refresh_token');
  });

  it('needs no Authorization header, and ignores an expired access token', async () => {
    const { app, issued } = await signedIn();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/token/refresh',
      headers: { authorization: 'Bearer not-a-valid-token' },
      payload: { refresh_token: issued.refreshToken },
    });
    // An invalid bearer token is refused everywhere, even here, so the phone
    // must send the refresh request without the dead access token.
    expect(response.statusCode).toBe(401);
    const clean = await refresh(app, issued.refreshToken);
    expect(clean.statusCode).toBe(200);
  });
});

describe('POST /v1/auth/logout', () => {
  it('revokes the session: 204, and the refresh token stops working', async () => {
    const { app, issued, accessToken } = await signedIn();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');

    const after = await refresh(app, issued.refreshToken);
    expect(after.statusCode).toBe(401);
  });

  it('requires a signed-in user', async () => {
    const { app } = await signedIn();
    const response = await app.inject({ method: 'POST', url: '/v1/auth/logout' });
    expect(response.statusCode).toBe(401);
  });

  it('is harmless to call twice', async () => {
    const { app, accessToken } = await signedIn();
    const headers = { authorization: `Bearer ${accessToken}` };
    const first = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers });
    const second = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers });
    expect(first.statusCode).toBe(204);
    // The access token is still valid for its 15 minutes; the session row is
    // already revoked, so the second call changes nothing and still says 204.
    expect(second.statusCode).toBe(204);
  });
});
