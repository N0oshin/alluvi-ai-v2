import { describe, expect, it } from 'vitest';
import { fakeDeps } from '../../../test/app-deps.js';
import { buildApp } from '../../app.js';
import { memoryAuditStore, type AuditStore } from '../../db/audit-store.js';
import { fakeEmail, type FakeEmail } from '../../providers/email/index.js';
import { fakeProviders } from '../../providers/index.js';

const install = 'install-aaaa-0000';
const userId = '019a0000-0000-7000-8000-000000000001';
const terms = { type: 'terms_and_privacy', version: '2026-09', granted: true };
const marketing = { type: 'marketing', version: '2026-09', granted: false };

// The audit store is passed in so a test can use the recording one (and read
// `entries`) or a broken one.
async function setup(audit: AuditStore) {
  const email = fakeEmail();
  const deps = fakeDeps({ audit, providers: { ...fakeProviders(), email } });
  const app = buildApp(deps);
  const device = await deps.devices.register(
    { installId: install, platform: 'ios', appVersion: '1.0.0', osVersion: '18.0' },
    new Date(),
  );
  return { deps, app, email, device };
}

function lastToken(email: FakeEmail): string {
  const text = email.sent.at(-1)?.text ?? '';
  const match = /token=([A-Za-z0-9_-]+)/.exec(text);
  if (match?.[1] === undefined) throw new Error('no token in the email');
  return match[1];
}

async function signUpByEmail(app: ReturnType<typeof buildApp>, email: FakeEmail) {
  await app.inject({
    method: 'POST',
    url: '/v1/auth/email/magic-links',
    payload: { email: 'ann@example.com', intent: 'sign_up', device_install_id: install },
  });
  return app.inject({
    method: 'POST',
    url: '/v1/auth/email/magic-links/consume',
    headers: { 'x-time-zone': 'Europe/London' },
    payload: { token: lastToken(email), device_install_id: install, consents: [terms, marketing] },
  });
}

describe('audit log', () => {
  it('records a sign-up and the consent decisions, without the email address', async () => {
    const audit = memoryAuditStore();
    const { app, email } = await setup(audit);
    const response = await signUpByEmail(app, email);
    expect(response.statusCode).toBe(201);

    expect(audit.entries.map((e) => e.action)).toEqual(['auth.sign_up', 'consent.recorded']);
    expect(audit.entries[0]).toMatchObject({ metadata: { provider: 'email' } });
    expect(audit.entries[1]?.metadata).toEqual({
      consents: [
        { type: 'terms_and_privacy', version: '2026-09', granted: true },
        { type: 'marketing', version: '2026-09', granted: false },
      ],
    });
    // The log is kept for a long time: no address, no token.
    const written = JSON.stringify(audit.entries);
    expect(written).not.toContain('ann@example.com');
    expect(written).not.toContain('mlt_');
  });

  it('records a failed sign-in with the reason and where it came from', async () => {
    const audit = memoryAuditStore();
    const { app } = await setup(audit);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/magic-links/consume',
      headers: { 'x-time-zone': 'Europe/London' },
      payload: { token: 'mlt_never-issued', device_install_id: install },
    });
    expect(response.statusCode).toBe(401);

    expect(audit.entries).toHaveLength(1);
    const [entry] = audit.entries;
    expect(entry).toMatchObject({
      action: 'auth.sign_in_failed',
      metadata: { provider: 'email', code: 'magic_link_invalid' },
    });
    expect(entry?.actorUserId).toBeUndefined();
    expect(entry?.ip).toBeTruthy();
    expect(entry?.requestId).toBeTruthy();
  });

  it('does not record a malformed request as a failed sign-in', async () => {
    const audit = memoryAuditStore();
    const { app } = await setup(audit);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/magic-links/consume',
      payload: {},
    });
    expect(response.statusCode).toBe(422);
    expect(audit.entries).toHaveLength(0);
  });

  it('still signs the person in when the audit log cannot be written', async () => {
    const broken: AuditStore = { record: () => Promise.reject(new Error('audit table down')) };
    const { app, email } = await setup(broken);
    const response = await signUpByEmail(app, email);
    expect(response.statusCode).toBe(201);
  });

  it('records a logout against the session', async () => {
    const audit = memoryAuditStore();
    const { app, deps, device } = await setup(audit);
    const issued = await deps.sessions.create(userId, device.id, new Date());
    const accessToken = await deps.accessTokens.issue({ userId, sessionId: issued.session.id });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(204);

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: 'auth.logout',
      actorUserId: userId,
      targetType: 'session',
      targetId: issued.session.id,
      deviceId: device.id,
    });
  });

  it('records a replayed refresh token', async () => {
    const audit = memoryAuditStore();
    const { app, deps, device } = await setup(audit);
    const issued = await deps.sessions.create(userId, device.id, new Date());
    const refresh = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/token/refresh',
        payload: { refresh_token: issued.refreshToken },
      });

    expect((await refresh()).statusCode).toBe(200);
    expect((await refresh()).statusCode).toBe(401);

    expect(audit.entries.map((e) => e.action)).toEqual(['auth.refresh_token_reuse']);
  });
});
