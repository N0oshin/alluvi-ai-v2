import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeDeps } from '../../../test/app-deps.js';
import { buildApp } from '../../app.js';
import { MAGIC_LINK_LIFETIME_MS } from '../../auth/magic-link-token.js';
import { memoryAccountStore } from '../../db/account-store.js';
import type { ErrorDetail } from '../../http/errors.js';
import { fakeEmail, type FakeEmail } from '../../providers/email/index.js';
import { fakeProviders } from '../../providers/index.js';
import type { SignInBody } from './sign-in.js';

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

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
  const deps = fakeDeps({ providers: { ...fakeProviders(), email }, accounts });
  const app = buildApp(deps);
  for (const installId of [install, otherInstall]) {
    await deps.devices.register(
      { installId, platform: 'ios', appVersion: '1.0.0', osVersion: '18.0' },
      new Date(),
    );
  }
  return { deps, app, email, accounts };
}

function request(app: ReturnType<typeof buildApp>, body: object) {
  return app.inject({ method: 'POST', url: '/v1/auth/email/magic-links', payload: body });
}

function consume(app: ReturnType<typeof buildApp>, body: object, timeZone = 'Europe/London') {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/email/magic-links/consume',
    headers: { 'x-time-zone': timeZone },
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

describe('POST /v1/auth/email/magic-links', () => {
  it('sends a link for sign_up and answers 202 with the cooldown', async () => {
    const { app, email } = await setup();
    const response = await request(app, {
      email: '  Hamish@Example.com ',
      intent: 'sign_up',
      device_install_id: install,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ sent: true, resend_available_in: 30 });

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

describe('POST /v1/auth/email/magic-links/consume', () => {
  it('creates the account on first use: 201 with tokens, then refuses a second use', async () => {
    const { app, deps, email, accounts } = await setup();
    const guest = await deps.guestSessions.create(randomUUID(), new Date());
    await request(app, {
      email: 'hamish@example.com',
      intent: 'sign_up',
      device_install_id: install,
      guest_session_id: guest.guestSession.id,
    });
    const token = lastToken(email);

    const first = await consume(app, { token, device_install_id: install, consents: [terms] });
    expect(first.statusCode).toBe(201);
    const body = first.json<SignInBody>();
    expect(body.is_new_user).toBe(true);
    expect(body.next_step).toBe('confirm_name');
    expect(body.user.first_name).toBe('hamish');
    expect(body.refresh_token).toMatch(/^rft_/);
    expect(accounts.claimedGuestSessions).toEqual([guest.guestSession.id]);

    const second = await consume(app, { token, device_install_id: install, consents: [terms] });
    expect(second.statusCode).toBe(409);
    expect(second.json<ErrorBody>().error.code).toBe('magic_link_already_used');
  });

  it('signs an existing account in with 200', async () => {
    const { app, email, accounts } = await setup();
    accounts.addUser({ email: 'hamish@example.com', username: 'h', firstName: 'Hamish' }, [
      { provider: 'email', subject: 'hamish@example.com' },
    ]);
    await request(app, {
      email: 'hamish@example.com',
      intent: 'sign_in',
      device_install_id: install,
    });

    const response = await consume(app, { token: lastToken(email), device_install_id: install });
    expect(response.statusCode).toBe(200);
    expect(response.json<SignInBody>().is_new_user).toBe(false);
  });

  it('needs the terms consent to create an account, and does not use the link up', async () => {
    const { app, email } = await setup();
    await request(app, { email: 'new@example.com', intent: 'sign_up', device_install_id: install });
    const token = lastToken(email);

    const refused = await consume(app, { token, device_install_id: install });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<ErrorBody>().error.code).toBe('consent_required');
    // The consume above marked the link used before sign-in refused, so the
    // person must request a new link. Documented in 02 §4.3.
    const retry = await consume(app, { token, device_install_id: install, consents: [terms] });
    expect(retry.statusCode).toBe(409);
  });

  it('refuses a link opened on another install until the person confirms', async () => {
    const { app, email } = await setup();
    await request(app, { email: 'new@example.com', intent: 'sign_up', device_install_id: install });
    const token = lastToken(email);

    const other = await consume(app, { token, device_install_id: otherInstall, consents: [terms] });
    expect(other.statusCode).toBe(409);
    expect(other.json<ErrorBody>().error.code).toBe('magic_link_other_device');

    const confirmed = await consume(app, {
      token,
      device_install_id: otherInstall,
      consents: [terms],
      confirm_device: true,
    });
    expect(confirmed.statusCode).toBe(201);
  });

  it('refuses an unknown token with 401 and an expired one with 410', async () => {
    const { app, deps } = await setup();
    const unknown = await consume(app, { token: 'mlt_never-issued', device_install_id: install });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json<ErrorBody>().error.code).toBe('magic_link_invalid');

    // Expiry, through the store: the route passes its own clock, so the
    // store is asked directly with a later time.
    const device = await deps.devices.findByInstallId(install);
    const issued = await deps.magicLinks.create(
      {
        email: 'a@example.com',
        intent: 'sign_up',
        guestSessionId: null,
        requestedDeviceId: device?.id ?? '',
        requestedIp: null,
      },
      new Date('2026-10-09T10:00:00Z'),
    );
    const late = new Date(Date.parse('2026-10-09T10:00:00Z') + MAGIC_LINK_LIFETIME_MS + 1);
    await expect(deps.magicLinks.peek(issued.token, late)).rejects.toMatchObject({
      code: 'magic_link_expired',
    });
  });

  it('requires the X-Time-Zone header', async () => {
    const { app, email } = await setup();
    await request(app, { email: 'new@example.com', intent: 'sign_up', device_install_id: install });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/magic-links/consume',
      payload: { token: lastToken(email), device_install_id: install, consents: [terms] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details[0]?.field).toBe('X-Time-Zone');
  });
});
