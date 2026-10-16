// One test file for the module's routes: the main happy path and the main
// refusal of each endpoint, against the test database.

import { randomUUID } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { fakeDeps } from '../../../test/app-deps.js';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  truncateAll,
} from '../../../test/db.js';
import { factories } from '../../../test/factories/index.js';
import { buildApp } from '../../app.js';
import { fakeEmail, type FakeEmail } from '../../providers/email/index.js';
import { fakeProviders } from '../../providers/index.js';
import { accessTokens } from '../../shared/auth/access-token.js';
import { APPLE, createIdentityTokenVerifier, GOOGLE } from '../../shared/auth/identity-token.js';
import type { ErrorDetail } from '../../shared/http/errors.js';
import { createSession } from './queries.js';
import type { SignInBody } from './sign-in.js';

type App = ReturnType<typeof buildApp>;

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}
interface GuestSessionBody {
  guest_session_id: string;
  guest_token: string;
  expires_at: string;
}
interface RefreshBody {
  access_token: string;
  access_expires_in: number;
  refresh_token: string;
}
interface RequestedBody {
  request_id: string;
  poll_interval: number;
  expires_in: number;
}
type ClaimBody =
  | { status: 'pending'; poll_interval: number; expires_in: number }
  | { status: 'ready'; sign_in: SignInBody };

const terms = { type: 'terms_and_privacy', version: '2026-09', granted: true };

function post(app: App, url: string, payload: object, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'x-time-zone': 'Europe/London', ...headers },
    payload,
  });
}

// What POST /v1/guest-sessions does for a phone on first launch.
async function registerInstall(app: App, installId: string) {
  const response = await post(
    app,
    '/v1/guest-sessions',
    {
      device: { platform: 'ios', app_version: '1.0.0', os_version: '18.0', install_id: installId },
    },
    { 'idempotency-key': randomUUID() },
  );
  expect(response.statusCode).toBe(201);
  return response.json<GuestSessionBody>();
}

// The token from the last email the fake provider recorded.
function lastToken(email: FakeEmail): string {
  const sent = email.sent.at(-1);
  if (sent === undefined) throw new Error('no email was sent');
  const match = /token=([A-Za-z0-9_-]+)/.exec(sent.text);
  if (match?.[1] === undefined) throw new Error('email has no token');
  return match[1];
}

describeWithDatabase('identity routes', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  const install = 'install-aaaa-0000';
  const otherInstall = 'install-bbbb-0000';

  // --- POST /v1/guest-sessions ------------------------------------------

  it('POST /v1/guest-sessions registers the device and issues a 30 day guest token', async () => {
    const app = buildApp(fakeDeps());
    const body = await registerInstall(app, install);
    expect(body.guest_token).toMatch(/^gst_/);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);

    // The guest token now authenticates a guest-only route.
    const onboarding = await app.inject({
      method: 'PUT',
      url: '/v1/onboarding/responses',
      headers: { authorization: `Bearer ${body.guest_token}` },
      payload: { sex: 'female' },
    });
    expect(onboarding.statusCode).toBe(200);
  });

  it('POST /v1/guest-sessions refuses a body that does not match', async () => {
    const app = buildApp(fakeDeps());
    const response = await post(
      app,
      '/v1/guest-sessions',
      { device: { platform: 'windows', install_id: 'x' } },
      { 'idempotency-key': randomUUID() },
    );
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.code).toBe('validation_failed');
  });

  // --- POST /v1/auth/token/refresh, POST /v1/auth/logout -----------------

  it('refresh rotates the token, and a replay of the old one ends the session', async () => {
    const app = buildApp(fakeDeps());
    const user = await factories.user.create();
    const device = await factories.device.create({ userId: user.id });
    const issued = await createSession(user.id, device.id, new Date());

    const first = await post(app, '/v1/auth/token/refresh', { refresh_token: issued.refreshToken });
    expect(first.statusCode).toBe(200);
    const rotated = first.json<RefreshBody>();
    expect(rotated.refresh_token).not.toBe(issued.refreshToken);
    expect(await accessTokens.verify(rotated.access_token)).toEqual({
      userId: user.id,
      sessionId: issued.session.id,
    });

    const replay = await post(app, '/v1/auth/token/refresh', {
      refresh_token: issued.refreshToken,
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json<ErrorBody>().error.code).toBe('refresh_token_reused');

    // The session is revoked for the new token too.
    const after = await post(app, '/v1/auth/token/refresh', {
      refresh_token: rotated.refresh_token,
    });
    expect(after.statusCode).toBe(401);
  });

  it('logout answers 204 and the refresh token stops working', async () => {
    const app = buildApp(fakeDeps());
    const user = await factories.user.create();
    const device = await factories.device.create({ userId: user.id });
    const issued = await createSession(user.id, device.id, new Date());
    const accessToken = await accessTokens.issue({ userId: user.id, sessionId: issued.session.id });

    const logout = await post(
      app,
      '/v1/auth/logout',
      {},
      { authorization: `Bearer ${accessToken}` },
    );
    expect(logout.statusCode).toBe(204);

    const refresh = await post(app, '/v1/auth/token/refresh', {
      refresh_token: issued.refreshToken,
    });
    expect(refresh.statusCode).toBe(401);
  });

  it('logout needs a signed-in user', async () => {
    const app = buildApp(fakeDeps());
    const response = await post(app, '/v1/auth/logout', {});
    expect(response.statusCode).toBe(401);
  });

  // --- Email magic links ------------------------------------------------

  it('magic link: request, page, confirm, claim signs a new user up', async () => {
    const email = fakeEmail();
    const app = buildApp(fakeDeps({ providers: { ...fakeProviders(), email } }));
    await registerInstall(app, install);

    const requested = await post(app, '/v1/auth/email/magic-links', {
      email: '  Hamish@Example.com ',
      intent: 'sign_up',
      device_install_id: install,
    });
    expect(requested.statusCode).toBe(202);
    const { request_id: id } = requested.json<RequestedBody>();
    expect(email.sent[0]?.to).toBe('hamish@example.com');
    const token = lastToken(email);

    // Not confirmed yet: the app's poll says pending.
    const pending = await post(app, `/v1/auth/email/magic-links/${id}/claim`, {
      device_install_id: install,
      consents: [terms],
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json<ClaimBody>().status).toBe('pending');

    // The page shows the confirm button; the button opens the link.
    const page = await app.inject({ method: 'GET', url: `/auth/magic-link?token=${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Confirm it');
    const opened = await post(app, '/v1/auth/email/magic-links/open', { token });
    expect(opened.statusCode).toBe(200);

    // The next poll signs in: a new account, so 201.
    const ready = await post(app, `/v1/auth/email/magic-links/${id}/claim`, {
      device_install_id: install,
      consents: [terms],
    });
    expect(ready.statusCode).toBe(201);
    const body = ready.json<ClaimBody>();
    expect(body.status).toBe('ready');
    if (body.status === 'ready') {
      expect(body.sign_in.is_new_user).toBe(true);
      expect(body.sign_in.user.first_name).toBe('hamish');
    }

    // Used up: a second claim is refused.
    const again = await post(app, `/v1/auth/email/magic-links/${id}/claim`, {
      device_install_id: install,
      consents: [terms],
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<ErrorBody>().error.code).toBe('magic_link_already_used');
  });

  it('magic link: another install cannot claim it, and sign_in needs an account', async () => {
    const email = fakeEmail();
    const app = buildApp(fakeDeps({ providers: { ...fakeProviders(), email } }));
    await registerInstall(app, install);
    await registerInstall(app, otherInstall);

    const unknown = await post(app, '/v1/auth/email/magic-links', {
      email: 'nobody@example.com',
      intent: 'sign_in',
      device_install_id: install,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<ErrorBody>().error.code).toBe('account_not_found');

    const requested = await post(app, '/v1/auth/email/magic-links', {
      email: 'hamish@example.com',
      intent: 'sign_up',
      device_install_id: install,
    });
    const { request_id: id } = requested.json<RequestedBody>();
    const stolen = await post(app, `/v1/auth/email/magic-links/${id}/claim`, {
      device_install_id: otherInstall,
      consents: [terms],
    });
    expect(stolen.statusCode).toBe(404);
  });

  // --- POST /v1/auth/apple, /v1/auth/google ------------------------------

  it('google sign-in verifies the identity token and creates the account', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const clientId = 'ai.alluvi.app';
    const keys = () => Promise.resolve(publicKey);
    const app = buildApp(
      fakeDeps({
        providers: {
          ...fakeProviders(),
          identityTokens: {
            apple: createIdentityTokenVerifier(APPLE, [clientId], { keys }),
            google: createIdentityTokenVerifier(GOOGLE, [clientId], { keys }),
          },
        },
      }),
    );
    await registerInstall(app, install);

    const identityToken = await new SignJWT({
      sub: 'google-sub-1',
      email: 'hamish@example.com',
      email_verified: true,
      given_name: 'Hamish',
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('https://accounts.google.com')
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

    const response = await post(app, '/v1/auth/google', {
      identity_token: identityToken,
      device_install_id: install,
      consents: [terms],
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<SignInBody>();
    expect(body.is_new_user).toBe(true);
    expect(body.user.first_name).toBe('Hamish');
    expect(body.next_step).toBe('confirm_name');
  });

  it('social sign-in answers 503 when the provider is not configured', async () => {
    const app = buildApp(fakeDeps());
    await registerInstall(app, install);
    const response = await post(app, '/v1/auth/apple', {
      identity_token: 'x'.repeat(20),
      device_install_id: install,
      consents: [terms],
    });
    expect(response.statusCode).toBe(503);
  });
});
