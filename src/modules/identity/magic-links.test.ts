import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeDeps } from '../../../test/app-deps.js';
import { buildApp } from '../../app.js';
import { MAGIC_LINK_LIFETIME_MS } from '../../auth/magic-link-token.js';
import { memoryAccountStore } from '../../db/account-store.js';
import { memoryAuditStore } from '../../db/audit-store.js';
import type { ErrorDetail } from '../../http/errors.js';
import { fakeEmail, type FakeEmail } from '../../providers/email/index.js';
import { fakeProviders } from '../../providers/index.js';
import type { SignInBody } from './sign-in.js';

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

interface RequestedBody {
  sent: boolean;
  resend_available_in: number;
  request_id: string;
  poll_interval: number;
  expires_in: number;
}

type ClaimBody =
  | { status: 'pending'; poll_interval: number; expires_in: number }
  | { status: 'ready'; sign_in: SignInBody };

const install = 'install-aaaa-0000';
const otherInstall = 'install-bbbb-0000';
const terms = { type: 'terms_and_privacy', version: '2026-09', granted: true };

// An app with two installs already registered, as POST /v1/guest-sessions
// would leave them.
// The email fake and the account fake are made here, not inside fakeDeps, so
// the test keeps them under their fake types and can read `sent`, call
// `addUser`, and so on. fakeDeps types them as the plain interfaces.
async function setup() {
  const email = fakeEmail();
  const accounts = memoryAccountStore();
  const audit = memoryAuditStore();
  const deps = fakeDeps({ providers: { ...fakeProviders(), email }, accounts, audit });
  const app = buildApp(deps);
  for (const installId of [install, otherInstall]) {
    await deps.devices.register(
      { installId, platform: 'ios', appVersion: '1.0.0', osVersion: '18.0' },
      new Date(),
    );
  }
  return { deps, app, email, accounts, audit };
}

type App = ReturnType<typeof buildApp>;

function request(app: App, body: object) {
  return app.inject({ method: 'POST', url: '/v1/auth/email/magic-links', payload: body });
}

function page(app: App, token: string | undefined) {
  return app.inject({
    method: 'GET',
    url: token === undefined ? '/auth/magic-link' : `/auth/magic-link?token=${token}`,
  });
}

function open(app: App, token: string) {
  return app.inject({ method: 'POST', url: '/v1/auth/email/magic-links/open', payload: { token } });
}

function claim(app: App, id: string, body: object, timeZone: string | undefined = 'Europe/London') {
  return app.inject({
    method: 'POST',
    url: `/v1/auth/email/magic-links/${id}/claim`,
    headers: timeZone === undefined ? {} : { 'x-time-zone': timeZone },
    payload: body,
  });
}

// The token from the last email the fake provider recorded.
function lastToken(email: FakeEmail): string {
  const sent = email.sent.at(-1);
  if (sent === undefined) throw new Error('no email was sent');
  const match = /token=([A-Za-z0-9_-]+)/.exec(sent.text);
  if (match?.[1] === undefined) throw new Error('email has no token');
  return match[1];
}

// Request a sign-up link for `address` and return what the app and the
// email each got.
async function requested(app: App, email: FakeEmail, address: string, extra: object = {}) {
  const response = await request(app, {
    email: address,
    intent: 'sign_up',
    device_install_id: install,
    ...extra,
  });
  expect(response.statusCode).toBe(202);
  return { id: response.json<RequestedBody>().request_id, token: lastToken(email) };
}

describe('POST /v1/auth/email/magic-links', () => {
  it('sends a link for sign_up and answers 202 with the request id and the cooldown', async () => {
    const { app, email } = await setup();
    const response = await request(app, {
      email: '  Hamish@Example.com ',
      intent: 'sign_up',
      device_install_id: install,
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<RequestedBody>();
    expect(body).toMatchObject({ sent: true, resend_available_in: 30, poll_interval: 3 });
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.expires_in).toBe(MAGIC_LINK_LIFETIME_MS / 1000);

    const [message] = email.sent;
    expect(message?.to).toBe('hamish@example.com');
    expect(message?.subject).toContain('sign-up');
    expect(message?.text).toContain('https://app.test/auth/magic-link?token=mlt_');
    expect(message?.html).toContain('token=mlt_');
  });

  it('answers 404 account_not_found for sign_in to an unknown address (screen 128)', async () => {
    const { app, email } = await setup();
    const response = await request(app, {
      email: 'nobody@example.com',
      intent: 'sign_in',
      device_install_id: install,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('account_not_found');
    expect(email.sent).toHaveLength(0);
  });

  it('refuses a bad address with invalid_email and an unknown install with 422', async () => {
    const { app } = await setup();
    const bad = await request(app, {
      email: 'not-an-email',
      intent: 'sign_up',
      device_install_id: install,
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<ErrorBody>().error.code).toBe('invalid_email');

    const unknown = await request(app, {
      email: 'a@example.com',
      intent: 'sign_up',
      device_install_id: 'install-never-registered',
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json<ErrorBody>().error.details[0]).toMatchObject({
      field: 'device_install_id',
      code: 'unknown_device',
    });
  });

  it('refuses an address that bounced or complained with email_undeliverable', async () => {
    const { app, deps, email } = await setup();
    await deps.emailSuppressions.suppress({
      email: 'gone@example.com',
      reason: 'bounce',
      providerEventId: null,
      at: new Date(),
    });
    const response = await request(app, {
      email: 'Gone@Example.com',
      intent: 'sign_up',
      device_install_id: install,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.code).toBe('email_undeliverable');
    expect(email.sent).toHaveLength(0);
  });

  it('enforces the 30 second cooldown per address', async () => {
    const { app } = await setup();
    const body = { email: 'a@example.com', intent: 'sign_up', device_install_id: install };
    expect((await request(app, body)).statusCode).toBe(202);
    const again = await request(app, body);
    expect(again.statusCode).toBe(429);
    expect(Number(again.headers['retry-after'])).toBeLessThanOrEqual(30);
  });

  it('removes the link and answers 503 when the email cannot be sent', async () => {
    const { app, email } = await setup();
    email.failNextWith = new Error('vendor down');
    const response = await request(app, {
      email: 'a@example.com',
      intent: 'sign_up',
      device_install_id: install,
    });
    expect(response.statusCode).toBe(503);
    expect(email.sent).toHaveLength(0);
  });
});

describe('GET /auth/magic-link (the page the email opens)', () => {
  it('shows the confirm button with a masked address, and never the token', async () => {
    const { app, email } = await setup();
    const { token } = await requested(app, email, 'hamish@example.com');

    const response = await page(app, token);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('Yes, sign me in');
    expect(response.body).toContain('h•••••@example.com');
    expect(response.body).not.toContain('hamish@example.com');
    expect(response.body).not.toContain(token);
  });

  it('shows the right message for a missing, unknown, used and confirmed link', async () => {
    const { app, email } = await setup();
    expect((await page(app, undefined)).body).toContain('not valid');
    expect((await page(app, 'mlt_never-issued')).body).toContain('not valid');

    const { id, token } = await requested(app, email, 'new@example.com');
    await open(app, token);
    expect((await page(app, token)).body).toContain("You're signed in");

    await claim(app, id, { device_install_id: install, consents: [terms] });
    expect((await page(app, token)).body).toContain('already used');
  });
});

describe('POST /v1/auth/email/magic-links/open', () => {
  it('marks the link opened, and a second confirm is harmless', async () => {
    const { app, email } = await setup();
    const { token } = await requested(app, email, 'new@example.com');

    const first = await open(app, token);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ opened: true, intent: 'sign_up' });
    expect((await open(app, token)).statusCode).toBe(200);
  });

  it('refuses an unknown token with 401 and a used one with 409, recording the failure', async () => {
    const { app, audit, email } = await setup();
    const unknown = await open(app, 'mlt_never-issued');
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json<ErrorBody>().error.code).toBe('magic_link_invalid');
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'auth.sign_in_failed',
      metadata: { provider: 'email', code: 'magic_link_invalid' },
    });

    const { id, token } = await requested(app, email, 'new@example.com');
    await open(app, token);
    await claim(app, id, { device_install_id: install, consents: [terms] });
    const used = await open(app, token);
    expect(used.statusCode).toBe(409);
    expect(used.json<ErrorBody>().error.code).toBe('magic_link_already_used');
  });
});

describe('POST /v1/auth/email/magic-links/{id}/claim', () => {
  it('answers pending until the link is confirmed, then creates the account with 201', async () => {
    const { app, deps, email, accounts } = await setup();
    const guest = await deps.guestSessions.create(randomUUID(), new Date());
    const { id, token } = await requested(app, email, 'hamish@example.com', {
      guest_session_id: guest.guestSession.id,
    });

    const waiting = await claim(app, id, { device_install_id: install, consents: [terms] });
    expect(waiting.statusCode).toBe(200);
    expect(waiting.headers['cache-control']).toBe('no-store');
    expect(waiting.json<ClaimBody>()).toMatchObject({ status: 'pending', poll_interval: 3 });
    expect(accounts.claimedGuestSessions).toEqual([]);

    await open(app, token);

    const ready = await claim(app, id, { device_install_id: install, consents: [terms] });
    expect(ready.statusCode).toBe(201);
    const body = ready.json<ClaimBody>();
    if (body.status !== 'ready') throw new Error('expected ready');
    expect(body.sign_in.is_new_user).toBe(true);
    expect(body.sign_in.next_step).toBe('confirm_name');
    expect(body.sign_in.user.first_name).toBe('hamish');
    expect(body.sign_in.refresh_token).toMatch(/^rft_/);
    expect(accounts.claimedGuestSessions).toEqual([guest.guestSession.id]);

    // The link is used up: another poll is refused, never a second sign-in.
    const again = await claim(app, id, { device_install_id: install, consents: [terms] });
    expect(again.statusCode).toBe(409);
    expect(again.json<ErrorBody>().error.code).toBe('magic_link_already_used');
  });

  it('signs an existing account in with 200', async () => {
    const { app, email, accounts } = await setup();
    accounts.addUser({ email: 'hamish@example.com', username: 'h', firstName: 'Hamish' }, [
      { provider: 'email', subject: 'hamish@example.com' },
    ]);
    const response = await request(app, {
      email: 'hamish@example.com',
      intent: 'sign_in',
      device_install_id: install,
    });
    const id = response.json<RequestedBody>().request_id;
    await open(app, lastToken(email));

    const ready = await claim(app, id, { device_install_id: install });
    expect(ready.statusCode).toBe(200);
    const body = ready.json<ClaimBody>();
    if (body.status !== 'ready') throw new Error('expected ready');
    expect(body.sign_in.is_new_user).toBe(false);
  });

  it('needs the terms consent to create an account, and the link is used up by then', async () => {
    const { app, email } = await setup();
    const { id, token } = await requested(app, email, 'new@example.com');
    await open(app, token);

    const refused = await claim(app, id, { device_install_id: install });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<ErrorBody>().error.code).toBe('consent_required');
    // Documented in 02 §4.4: the person requests a new link.
    const retry = await claim(app, id, { device_install_id: install, consents: [terms] });
    expect(retry.statusCode).toBe(409);
  });

  it('answers 404 to another install and to an unknown id, 422 to a malformed one', async () => {
    const { app, email } = await setup();
    const { id, token } = await requested(app, email, 'new@example.com');
    await open(app, token);

    const other = await claim(app, id, { device_install_id: otherInstall, consents: [terms] });
    expect(other.statusCode).toBe(404);
    expect(other.json<ErrorBody>().error.code).toBe('not_found');

    const unknown = await claim(app, randomUUID(), { device_install_id: install });
    expect(unknown.statusCode).toBe(404);

    const malformed = await claim(app, 'not-a-uuid', { device_install_id: install });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json<ErrorBody>().error.details[0]?.field).toBe('id');

    // The link is still live for the install that asked.
    const mine = await claim(app, id, { device_install_id: install, consents: [terms] });
    expect(mine.statusCode).toBe(201);
  });

  it('answers 410 once the link has expired', async () => {
    const { app, deps } = await setup();
    // Through the store with its own clock: the route reads the row's
    // expiry, so a row created in the past is enough.
    const device = await deps.devices.findByInstallId(install);
    const issued = await deps.magicLinks.create(
      {
        email: 'a@example.com',
        intent: 'sign_up',
        guestSessionId: null,
        requestedDeviceId: device?.id ?? '',
        requestedIp: null,
      },
      new Date(Date.now() - MAGIC_LINK_LIFETIME_MS - 1000),
    );
    const response = await claim(app, issued.link.id, { device_install_id: install });
    expect(response.statusCode).toBe(410);
    expect(response.json<ErrorBody>().error.code).toBe('magic_link_expired');
  });

  it('requires the X-Time-Zone header', async () => {
    const { app, email } = await setup();
    const { id } = await requested(app, email, 'new@example.com');
    const response = await claim(app, id, { device_install_id: install }, undefined);
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details[0]?.field).toBe('X-Time-Zone');
  });
});
