import { createHash } from 'node:crypto';
import { generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  APPLE,
  createIdentityTokenVerifier,
  GOOGLE,
  type IdentityProvider,
} from './identity-token.js';

// A stand-in for the provider: a key pair made here. Tokens are signed with
// the private half; the verifier is handed the public half instead of
// fetching the provider's JWKS.
let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair('ES256'));
});

const clientId = 'ai.alluvi.app';
const now = new Date('2026-10-09T10:00:00Z');
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

async function tokenFrom(
  provider: IdentityProvider,
  claims: JWTPayload,
  overrides: Partial<{ issuer: string; audience: string; expiresAt: Date }> = {},
) {
  const issuer =
    overrides.issuer ??
    (Array.isArray(provider.issuer) ? (provider.issuer[0] ?? '') : provider.issuer);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'test' })
    .setIssuer(issuer)
    .setAudience(overrides.audience ?? clientId)
    .setIssuedAt(seconds(now))
    .setExpirationTime(seconds(overrides.expiresAt ?? new Date(now.getTime() + 600_000)))
    .sign(privateKey);
}

function verifier(provider: IdentityProvider) {
  return createIdentityTokenVerifier(provider, [clientId], {
    keys: () => Promise.resolve(publicKey),
    now: () => now,
  });
}

describe('createIdentityTokenVerifier', () => {
  it('accepts a good Google token and reads subject, verified email and names', async () => {
    const token = await tokenFrom(GOOGLE, {
      sub: 'google-123',
      email: 'Hamish@Example.com',
      email_verified: true,
      given_name: 'Hamish',
      family_name: 'Grayson',
      nonce: 'abc',
    });
    const identity = await verifier(GOOGLE).verify(token, 'abc');
    expect(identity).toEqual({
      subject: 'google-123',
      email: 'hamish@example.com',
      givenName: 'Hamish',
      familyName: 'Grayson',
    });
  });

  it('accepts an Apple token whose nonce claim is the SHA-256 of the app nonce', async () => {
    const nonce = 'c2a1-random';
    const token = await tokenFrom(APPLE, {
      sub: 'apple-001',
      email: 'h@privaterelay.appleid.com',
      email_verified: 'true',
      nonce: createHash('sha256').update(nonce).digest('hex'),
    });
    const identity = await verifier(APPLE).verify(token, nonce);
    expect(identity.subject).toBe('apple-001');
    expect(identity.email).toBe('h@privaterelay.appleid.com');
    expect(identity.givenName).toBeNull();
  });

  it('drops an email the provider did not verify', async () => {
    const token = await tokenFrom(GOOGLE, {
      sub: 's',
      email: 'x@example.com',
      email_verified: false,
    });
    expect((await verifier(GOOGLE).verify(token, undefined)).email).toBeNull();
  });

  it('accepts a token with no nonce claim when none is sent', async () => {
    const token = await tokenFrom(GOOGLE, { sub: 's' });
    expect((await verifier(GOOGLE).verify(token, undefined)).subject).toBe('s');
  });

  it('refuses wrong nonce, missing nonce, wrong audience, wrong issuer, expiry and bad signature', async () => {
    const v = verifier(GOOGLE);
    const refuse = async (token: string, nonce?: string) =>
      expect(v.verify(token, nonce)).rejects.toMatchObject({ code: 'invalid_identity_token' });

    await refuse(await tokenFrom(GOOGLE, { sub: 's', nonce: 'abc' }), 'wrong');
    await refuse(await tokenFrom(GOOGLE, { sub: 's', nonce: 'abc' }), undefined);
    await refuse(await tokenFrom(GOOGLE, { sub: 's' }, { audience: 'someone-else' }));
    await refuse(await tokenFrom(GOOGLE, { sub: 's' }, { issuer: 'https://evil.example' }));
    await refuse(
      await tokenFrom(GOOGLE, { sub: 's' }, { expiresAt: new Date(now.getTime() - 1000) }),
    );
    await refuse('not.a.jwt');

    // Signed by a different key.
    const other = await generateKeyPair('ES256');
    const forged = await new SignJWT({ sub: 's' })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('https://accounts.google.com')
      .setAudience(clientId)
      .setExpirationTime(seconds(now) + 600)
      .sign(other.privateKey);
    await refuse(forged);
  });

  it('refuses to be built without a client id', () => {
    expect(() => createIdentityTokenVerifier(APPLE, [])).toThrow(/client id/);
  });
});
