import { createHash } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeDeps } from '../../../test/app-deps.js';
import { buildApp } from '../../app.js';
import { APPLE, createIdentityTokenVerifier, GOOGLE } from '../../auth/identity-token.js';
import { memoryAccountStore } from '../../db/account-store.js';
import type { ErrorDetail } from '../../http/errors.js';
import type { SignInBody } from './sign-in.js';

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

let privateKey: CryptoKey;
let publicKey: CryptoKey;
beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair('ES256'));
});

const clientId = 'ai.alluvi.app';
const install = 'install-aaaa-0000';
const terms = { type: 'terms_and_privacy', version: '2026-09', granted: true };

async function googleToken(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer('https://accounts.google.com')
    .setAudience(clientId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function appleToken(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer('https://appleid.apple.com')
    .setAudience(clientId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function setup(configured = true) {
  const accounts = memoryAccountStore();
  const keys = () => Promise.resolve(publicKey);
  const deps = fakeDeps({
    accounts,
    identityTokens: configured
      ? {
          apple: createIdentityTokenVerifier(APPLE, [clientId], { keys }),
          google: createIdentityTokenVerifier(GOOGLE, [clientId], { keys }),
        }
      : {},
  });
  const app = buildApp(deps);
  await deps.devices.register(
    { installId: install, platform: 'ios', appVersion: '1.0.0', osVersion: '18.0' },
    new Date(),
  );
  return { app, deps, accounts };
}

function post(app: ReturnType<typeof buildApp>, path: string, body: object) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'x-time-zone': 'Europe/London' },
    payload: body,
  });
}

describe('POST /v1/auth/google', () => {
  it('creates an account from a verified token: 201, confirm_name, name from the token', async () => {
    const { app, accounts } = await setup();
    const token = await googleToken({
      sub: 'g-1',
      email: 'hamish@example.com',
      email_verified: true,
      given_name: 'Hamish',
      family_name: 'Grayson',
      nonce: 'n1',
    });
    const response = await post(app, '/v1/auth/google', {
      identity_token: token,
      nonce: 'n1',
      device_install_id: install,
      consents: [terms],
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<SignInBody>();
    expect(body.is_new_user).toBe(true);
    expect(body.next_step).toBe('confirm_name');
    expect(body.user.first_name).toBe('Hamish');
    expect(accounts.users.size).toBe(1);

    // Same person again: 200, no second account.
    const again = await post(app, '/v1/auth/google', {
      identity_token: await googleToken({
        sub: 'g-1',
        email: 'hamish@example.com',
        email_verified: true,
      }),
      device_install_id: install,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<SignInBody>().is_new_user).toBe(false);
    expect(accounts.users.size).toBe(1);
  });

  it('refuses a bad token with 401 invalid_identity_token and creates nothing', async () => {
    const { app, accounts } = await setup();
    const forged = await new SignJWT({ sub: 'g-2' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('https://accounts.google.com')
      .setAudience('someone-else')
      .setExpirationTime('10m')
      .sign(privateKey);
    const response = await post(app, '/v1/auth/google', {
      identity_token: forged,
      device_install_id: install,
      consents: [terms],
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('invalid_identity_token');
    expect(accounts.users.size).toBe(0);
  });

  it('answers 409 when the email already belongs to an Apple account', async () => {
    const { app, accounts } = await setup();
    accounts.addUser({ email: 'hamish@example.com' }, [{ provider: 'apple', subject: 'a-1' }]);
    const response = await post(app, '/v1/auth/google', {
      identity_token: await googleToken({
        sub: 'g-3',
        email: 'hamish@example.com',
        email_verified: true,
      }),
      device_install_id: install,
      consents: [terms],
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.details[0]?.code).toBe('use_apple');
  });

  it('needs the terms consent for a new account', async () => {
    const { app } = await setup();
    const response = await post(app, '/v1/auth/google', {
      identity_token: await googleToken({
        sub: 'g-4',
        email: 'new@example.com',
        email_verified: true,
      }),
      device_install_id: install,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.code).toBe('consent_required');
  });

  it('answers 503 when the provider is not configured', async () => {
    const { app } = await setup(false);
    const response = await post(app, '/v1/auth/google', {
      identity_token: await googleToken({ sub: 'g-5' }),
      device_install_id: install,
    });
    expect(response.statusCode).toBe(503);
  });
});

describe('POST /v1/auth/apple', () => {
  it('uses the name from the body when the token has none, and hashes the nonce', async () => {
    const { app } = await setup();
    const nonce = 'apple-nonce';
    const token = await appleToken({
      sub: 'a-9',
      email: 'h@privaterelay.appleid.com',
      email_verified: 'true',
      nonce: createHash('sha256').update(nonce).digest('hex'),
    });
    const response = await post(app, '/v1/auth/apple', {
      identity_token: token,
      nonce,
      device_install_id: install,
      consents: [terms],
      given_name: 'Hamish',
      family_name: 'Grayson',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<SignInBody>().user.first_name).toBe('Hamish');
  });

  it('refuses when the nonce does not match the token', async () => {
    const { app } = await setup();
    const token = await appleToken({
      sub: 'a-10',
      nonce: createHash('sha256').update('real').digest('hex'),
    });
    const response = await post(app, '/v1/auth/apple', {
      identity_token: token,
      nonce: 'replayed',
      device_install_id: install,
      consents: [terms],
    });
    expect(response.statusCode).toBe(401);
  });
});
