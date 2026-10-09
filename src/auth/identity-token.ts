// Verifying Sign in with Apple and Google identity tokens.
//
// Both providers hand the phone an *identity token*: a JWT, signed by the
// provider, saying "this is person <sub>, their email is <email>, and this
// token was made for app <aud>". The phone forwards it to us. We check it
// the way we check our own access tokens (backend notes, entry 38), except
// the public keys are the provider's, fetched from a published URL (a JWKS)
// and cached. Backend notes, entry 45.
//
// What is checked: signature against the provider's current keys, issuer,
// audience (one of our client ids), expiry, and the nonce when the token
// carries one. Any failure is 401 invalid_identity_token; the reason is not
// revealed to the caller.

import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AppError } from '../http/errors.js';

export interface VerifiedIdentity {
  // The provider's stable id for the person. Never their email.
  subject: string;
  // Only when the provider says the address is verified; otherwise null.
  email: string | null;
  givenName: string | null;
  familyName: string | null;
}

export interface IdentityTokenVerifier {
  verify(identityToken: string, nonce: string | undefined): Promise<VerifiedIdentity>;
}

// What differs between the two providers.
export interface IdentityProvider {
  name: 'apple' | 'google';
  issuer: string | string[];
  jwksUrl: string;
  // Apple puts the SHA-256 of the app's nonce in the token; Google the nonce itself.
  hashesNonce: boolean;
}

export const APPLE: IdentityProvider = {
  name: 'apple',
  issuer: 'https://appleid.apple.com',
  jwksUrl: 'https://appleid.apple.com/auth/keys',
  hashesNonce: true,
};

export const GOOGLE: IdentityProvider = {
  name: 'google',
  issuer: ['https://accounts.google.com', 'accounts.google.com'],
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  hashesNonce: false,
};

export interface IdentityTokenVerifierOptions {
  // Where to get the public keys. Defaults to the provider's JWKS URL; tests
  // pass a function that returns a local key.
  keys?: JWTVerifyGetKey;
  now?: () => Date;
}

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

// Apple sends email_verified as the string "true" on some tokens and a
// boolean on others. Anything but an explicit false counts as verified.
function isVerified(flag: unknown): boolean {
  return flag !== false && flag !== 'false';
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export function createIdentityTokenVerifier(
  provider: IdentityProvider,
  clientIds: string[],
  options: IdentityTokenVerifierOptions = {},
): IdentityTokenVerifier {
  if (clientIds.length === 0) {
    throw new Error(`${provider.name} sign-in needs at least one client id`);
  }
  const keys = options.keys ?? createRemoteJWKSet(new URL(provider.jwksUrl));
  const now = options.now ?? (() => new Date());

  return {
    async verify(identityToken, nonce) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(identityToken, keys, {
          issuer: provider.issuer,
          audience: clientIds,
          currentDate: now(),
        }));
      } catch {
        throw new AppError('invalid_identity_token');
      }

      // The nonce ties this token to this sign-in attempt: the app made a
      // random value, gave it to the provider, and sends it to us. A token
      // replayed from another attempt has a different one.
      const claimedNonce = payload['nonce'];
      if (typeof claimedNonce === 'string') {
        const expected =
          nonce === undefined ? undefined : provider.hashesNonce ? sha256Hex(nonce) : nonce;
        if (expected !== claimedNonce) throw new AppError('invalid_identity_token');
      }

      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new AppError('invalid_identity_token');
      }

      const email = stringOrNull(payload['email']);
      return {
        subject: payload.sub,
        email: email !== null && isVerified(payload['email_verified']) ? email.toLowerCase() : null,
        givenName: stringOrNull(payload['given_name']),
        familyName: stringOrNull(payload['family_name']),
      };
    },
  };
}
