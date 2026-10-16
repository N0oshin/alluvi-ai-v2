// Access tokens: short-lived proof that a request comes from a signed-in
// session.
//
// An access token is a JWT (JSON Web Token): carries the user id
// (`sub`), the session id (`sid`), who issued it, who it is for, and when it
// expires, 15 minutes after issue. It is signed with a private Ed25519 key and
// checked with the matching public key, so a server that only verifies never
// needs the secret.
//
// Key rotation: the service takes a list of keys. The first signs; all verify.
// Each token names its key in the `kid` header, so during a rotation tokens
// signed by the old key keep working until they expire. Backend notes, entry 38.

import { randomBytes } from 'node:crypto';
import {
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
} from 'jose';
import { AppError } from '../http/errors.js';
import type { AccessTokenKey } from './keys.js';

export const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;

// Written into every token and required on verification.
const ALGORITHM = 'EdDSA';
const ISSUER = 'alluvi-api';
const AUDIENCE = 'alluvi-app';
const TOKEN_TYPE = 'at+jwt';

// What a token says once verified.
export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
}

export interface AccessTokenService {
  // issue takes the claims and eventually gives back a string(token)
  issue(claims: AccessTokenClaims): Promise<string>;
  verify(token: string): Promise<AccessTokenClaims>;
}

export interface AccessTokenOptions {
  now?: () => Date;
}

// `CryptoKey` is Node's built-in Web Crypto key type; importJWK returns one.
interface LoadedKey {
  kid: string;
  privateKey: CryptoKey | Uint8Array;
  publicKey: CryptoKey | Uint8Array;
}

interface LoadedKeys {
  signing: LoadedKey;
  byKid: Map<string, LoadedKey>;
}

// Turns the JWK records into key objects the crypto library can use. The
// public key is imported from the JWK minus its secret part `d`.
async function loadKeys(keys: AccessTokenKey[]): Promise<LoadedKeys> {
  const loaded = await Promise.all(
    keys.map(async (key): Promise<LoadedKey> => ({
      kid: key.kid,
      privateKey: await importJWK(key, ALGORITHM),
      publicKey: await importJWK({ kty: key.kty, crv: key.crv, x: key.x }, ALGORITHM),
    })),
  );
  const signing = loaded[0];
  if (signing === undefined) {
    throw new Error('at least one access token key is required');
  }
  const byKid = new Map(loaded.map((key) => [key.kid, key]));
  if (byKid.size !== loaded.length) {
    throw new Error('every access token key needs a different kid');
  }
  return { signing, byKid };
}

//  server.ts calls at start-up, and the object it returns is what will sign every token in production and verify every request.

//you give it the keys, it hands back an object with the two methods, issue and verify

export function createAccessTokenService(
  keys: AccessTokenKey[] | Promise<AccessTokenKey[]>,
  options: AccessTokenOptions = {},
): AccessTokenService {
  const now = options.now ?? (() => new Date());
  let ready: Promise<LoadedKeys> | undefined;
  const loaded = () => {
    ready ??= Promise.resolve(keys).then(loadKeys);
    return ready;
  };

  //the function returns an object with two methods. issue and verify. issue takes the claims and eventually gives back a string(token). verify takes a token and eventually gives back the claims.

  //issue runs at sign-in and at refresh. It creates and signs a new token and the server sends it to the phone.

  // verify runs when a request arrives carrying a token. It checks the signature and fields and tells the rest of the code which user and session this is.
  return {
    async issue(claims) {
      const { signing } = await loaded();
      const issuedAt = Math.floor(now().getTime() / 1000);
      return new SignJWT({ sid: claims.sessionId })
        .setProtectedHeader({ alg: ALGORITHM, kid: signing.kid, typ: TOKEN_TYPE })
        .setSubject(claims.userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ACCESS_TOKEN_LIFETIME_SECONDS)
        .sign(signing.privateKey);
    },

    async verify(token) {
      const { byKid } = await loaded();

      let kid: string | undefined;
      try {
        kid = decodeProtectedHeader(token).kid;
      } catch {
        throw new AppError('unauthenticated');
      }
      const key = kid === undefined ? undefined : byKid.get(kid);
      if (key === undefined) {
        throw new AppError('unauthenticated');
      }

      try {
        const { payload } = await jwtVerify(token, key.publicKey, {
          algorithms: [ALGORITHM],
          issuer: ISSUER,
          audience: AUDIENCE,
          typ: TOKEN_TYPE,
          currentDate: now(),
        });
        const sessionId = payload['sid'];
        if (typeof payload.sub !== 'string' || typeof sessionId !== 'string') {
          throw new AppError('unauthenticated');
        }
        return { userId: payload.sub, sessionId };
      } catch (error) {
        if (error instanceof AppError) throw error;
        // Expired, bad signature, wrong issuer or audience, malformed: all 401.
        throw new AppError('unauthenticated');
      }
    },
  };
}

// This one makes a brand new key.
// `kid` defaults to the date plus a few random characters,
// so keys made on the same day still differ.
export async function generateAccessTokenKey(kid?: string): Promise<AccessTokenKey> {
  const { privateKey } = await generateKeyPair(ALGORITHM, { crv: 'Ed25519', extractable: true });
  const jwk = await exportJWK(privateKey);
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || jwk.x === undefined || jwk.d === undefined) {
    throw new Error('unexpected key format from the crypto library');
  }
  return {
    kid: kid ?? `${new Date().toISOString().slice(0, 10)}-${randomBytes(2).toString('hex')}`,
    kty: 'OKP',
    crv: 'Ed25519',
    x: jwk.x,
    d: jwk.d,
  };
}

// A service with a key that exists only in this process: for tests, and for
// development when ACCESS_TOKEN_KEYS is not set. Every token it issued stops
// working when the process restarts.
export function ephemeralAccessTokenService(options: AccessTokenOptions = {}): AccessTokenService {
  return createAccessTokenService(
    generateAccessTokenKey('ephemeral').then((key) => [key]),
    options,
  );
}
