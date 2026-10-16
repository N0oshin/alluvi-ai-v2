import { importJWK, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../http/errors.js';
import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  createAccessTokenService,
  ephemeralAccessTokenService,
  generateAccessTokenKey,
} from './access-token.js';
import { parseAccessTokenKeys, type AccessTokenKey } from './keys.js';

const claims = {
  userId: '019a0000-0000-7000-8000-000000000001',
  sessionId: '019a0000-0000-7000-8000-000000000002',
};

// Two real keys, generated once for the whole file.
let keyA: AccessTokenKey;
let keyB: AccessTokenKey;
beforeAll(async () => {
  keyA = await generateAccessTokenKey('a');
  keyB = await generateAccessTokenKey('b');
});

// Reads the three base64url parts of a token without verifying anything.
function decode(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [header = '', payload = ''] = token.split('.');
  const json = (part: string) =>
    JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;
  return { header: json(header), payload: json(payload) };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('access tokens', () => {
  it('issues a token that verifies back to the same claims', async () => {
    const service = createAccessTokenService([keyA]);
    const token = await service.issue(claims);
    expect(token.split('.')).toHaveLength(3);
    await expect(service.verify(token)).resolves.toEqual(claims);
  });

  it('names the signing key and the token type in the header, and expires in 15 minutes', async () => {
    const issuedAt = new Date('2026-10-08T10:00:00Z');
    const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1000);
    const service = createAccessTokenService([keyA], { now: () => issuedAt });
    const { header, payload } = decode(await service.issue(claims));
    expect(header).toEqual({ alg: 'EdDSA', kid: 'a', typ: 'at+jwt' });
    expect(payload).toEqual({
      sub: claims.userId,
      sid: claims.sessionId,
      iss: 'alluvi-api',
      aud: 'alluvi-app',
      iat: issuedAtSeconds,
      exp: issuedAtSeconds + ACCESS_TOKEN_LIFETIME_SECONDS,
    });
  });

  it('rejects an expired token with 401 unauthenticated', async () => {
    let clock = new Date('2026-10-08T10:00:00Z');
    const service = createAccessTokenService([keyA], { now: () => clock });
    const token = await service.issue(claims);
    clock = new Date('2026-10-08T10:14:00Z');
    await expect(service.verify(token)).resolves.toEqual(claims);
    clock = new Date('2026-10-08T10:16:00Z');
    const error = await rejection(service.verify(token));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('unauthenticated');
  });

  it('rejects a tampered token, a token signed by an unknown key, and garbage', async () => {
    const service = createAccessTokenService([keyA]);
    const token = await service.issue(claims);
    const [header = '', , signature = ''] = token.split('.');
    const otherPayload = Buffer.from(
      JSON.stringify({ ...decode(token).payload, sub: '019a0000-0000-7000-8000-000000000099' }),
    ).toString('base64url');
    const tampered = `${header}.${otherPayload}.${signature}`;
    const otherKey = createAccessTokenService([keyB]);

    for (const bad of [tampered, await otherKey.issue(claims), 'not.a.token', '']) {
      const error = await rejection(service.verify(bad));
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('unauthenticated');
    }
  });

  it('rejects a well-signed token made for another audience or of another type', async () => {
    const service = createAccessTokenService([keyA]);
    const privateKey = await importJWK(keyA, 'EdDSA');
    const base = () =>
      new SignJWT({ sid: claims.sessionId })
        .setSubject(claims.userId)
        .setIssuer('alluvi-api')
        .setIssuedAt()
        .setExpirationTime('15m');

    const wrongAudience = await base()
      .setProtectedHeader({ alg: 'EdDSA', kid: 'a', typ: 'at+jwt' })
      .setAudience('someone-else')
      .sign(privateKey);
    const wrongType = await base()
      .setProtectedHeader({ alg: 'EdDSA', kid: 'a', typ: 'JWT' })
      .setAudience('alluvi-app')
      .sign(privateKey);
    const noSession = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: 'a', typ: 'at+jwt' })
      .setSubject(claims.userId)
      .setIssuer('alluvi-api')
      .setAudience('alluvi-app')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(privateKey);

    for (const bad of [wrongAudience, wrongType, noSession]) {
      expect(((await rejection(service.verify(bad))) as AppError).code).toBe('unauthenticated');
    }
  });

  it('rotates: the first key signs, every listed key verifies', async () => {
    const oldService = createAccessTokenService([keyA]);
    const oldToken = await oldService.issue(claims);

    // Rotation: new key first, old key kept while its tokens are alive.
    const rotated = createAccessTokenService([keyB, keyA]);
    await expect(rotated.verify(oldToken)).resolves.toEqual(claims);
    const newToken = await rotated.issue(claims);
    expect(decode(newToken).header['kid']).toBe('b');
    await expect(rotated.verify(newToken)).resolves.toEqual(claims);

    // After the old key is dropped, its tokens are refused.
    const retired = createAccessTokenService([keyB]);
    await expect(retired.verify(newToken)).resolves.toEqual(claims);
    expect(((await rejection(retired.verify(oldToken))) as AppError).code).toBe('unauthenticated');
  });

  it('refuses an empty key list and duplicate kids on first use', async () => {
    await expect(createAccessTokenService([]).issue(claims)).rejects.toThrow(/at least one/);
    await expect(createAccessTokenService([keyA, keyA]).issue(claims)).rejects.toThrow(
      /different kid/,
    );
  });

  it('ephemeral service works on its own and only with itself', async () => {
    const one = ephemeralAccessTokenService();
    const two = ephemeralAccessTokenService();
    const token = await one.issue(claims);
    await expect(one.verify(token)).resolves.toEqual(claims);
    expect(((await rejection(two.verify(token))) as AppError).code).toBe('unauthenticated');
  });
});

describe('parseAccessTokenKeys', () => {
  it('accepts a JSON array of keys in order', () => {
    const keys = parseAccessTokenKeys(JSON.stringify([keyB, keyA]));
    expect(keys.map((k) => k.kid)).toEqual(['b', 'a']);
  });

  it('names the problem for bad JSON, a wrong shape, an empty list and a duplicate kid', () => {
    expect(() => parseAccessTokenKeys('{')).toThrow(/JSON array/);
    expect(() => parseAccessTokenKeys('[]')).toThrow(/invalid key list/);
    expect(() => parseAccessTokenKeys(JSON.stringify([{ ...keyA, kty: 'RSA' }]))).toThrow(/0\.kty/);
    expect(() => parseAccessTokenKeys(JSON.stringify([{ ...keyA, extra: 1 }]))).toThrow(
      /invalid key list/,
    );
    expect(() => parseAccessTokenKeys(JSON.stringify([keyA, { ...keyB, kid: 'a' }]))).toThrow(
      /different kid/,
    );
  });
});
