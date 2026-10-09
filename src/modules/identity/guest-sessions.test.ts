import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeDeps } from '../../../test/app-deps.js';
import { buildApp } from '../../app.js';
import { GUEST_TOKEN_LIFETIME_MS } from '../../auth/guest-token.js';
import type { ErrorDetail } from '../../http/errors.js';

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

interface GuestSessionBody {
  guest_session_id: string;
  guest_token: string;
  expires_at: string;
}

const device = {
  platform: 'ios',
  app_version: '1.0.0',
  os_version: '18.0',
  install_id: 'b1f6c2d4-0000-install',
};

// `body: object` rather than `unknown`: inject's payload must be a string or
// an object, and with `unknown` TypeScript cannot match that overload.
function post(app: ReturnType<typeof buildApp>, body: object, key = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: '/v1/guest-sessions',
    headers: { 'idempotency-key': key },
    payload: body,
  });
}

describe('POST /v1/guest-sessions', () => {
  it('registers the device and answers 201 with a 30 day guest token', async () => {
    const before = Date.now();
    const deps = fakeDeps();
    const app = buildApp(deps);

    const response = await post(app, { device });
    expect(response.statusCode).toBe(201);

    const body = response.json<GuestSessionBody>();
    expect(body.guest_token).toMatch(/^gst_/);
    const expiresAt = new Date(body.expires_at).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + GUEST_TOKEN_LIFETIME_MS);

    // The token resolves to the session, and the session belongs to the
    // device row made from install_id.
    const session = await deps.guestSessions.resolve(body.guest_token, new Date());
    expect(session.id).toBe(body.guest_session_id);
    const registered = await deps.devices.findByInstallId(device.install_id);
    expect(registered?.id).toBe(session.deviceId);
  });

  it('lets the guest token through the authentication hook on a guest route', async () => {
    const app = buildApp(fakeDeps());
    app.get('/whoami', { config: { auth: 'guest' } }, (request) => request.principal);

    const created = await post(app, { device });
    const token = created.json<GuestSessionBody>().guest_token;
    const response = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: 'guest' });
  });

  it('reuses the device row for a second request from the same install', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const first = await post(app, { device });
    const second = await post(app, { device: { ...device, app_version: '1.1.0' } });

    const a = await deps.guestSessions.resolve(
      first.json<GuestSessionBody>().guest_token,
      new Date(),
    );
    const b = await deps.guestSessions.resolve(
      second.json<GuestSessionBody>().guest_token,
      new Date(),
    );
    expect(a.id).not.toBe(b.id);
    expect(a.deviceId).toBe(b.deviceId);
  });

  it('replays the same response for the same Idempotency-Key', async () => {
    const app = buildApp(fakeDeps());
    const key = randomUUID();
    const first = await post(app, { device }, key);
    const replay = await post(app, { device }, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('refuses a body with missing or unknown fields with 422', async () => {
    const app = buildApp(fakeDeps());

    const missing = await post(app, { device: { platform: 'ios' } });
    expect(missing.statusCode).toBe(422);
    const fields = missing.json<ErrorBody>().error.details.map((d) => d.field);
    expect(fields).toEqual(
      expect.arrayContaining(['device.app_version', 'device.os_version', 'device.install_id']),
    );

    const unknown = await post(app, { device: { ...device, color: 'blue' } });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json<ErrorBody>().error.details[0]).toMatchObject({
      field: 'device.color',
      code: 'unknown_field',
    });

    const badPlatform = await post(app, { device: { ...device, platform: 'windows' } });
    expect(badPlatform.statusCode).toBe(422);
  });

  it('requires an Idempotency-Key', async () => {
    const app = buildApp(fakeDeps());
    const response = await app.inject({
      method: 'POST',
      url: '/v1/guest-sessions',
      payload: { device },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details[0]?.field).toBe('Idempotency-Key');
  });

  it('allows 10 per hour per install id, then answers 429 with Retry-After', async () => {
    const app = buildApp(fakeDeps());
    for (let i = 0; i < 10; i += 1) {
      const ok = await post(app, { device });
      expect(ok.statusCode).toBe(201);
    }
    const refused = await post(app, { device });
    expect(refused.statusCode).toBe(429);
    expect(refused.json<ErrorBody>().error.code).toBe('rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });
});
