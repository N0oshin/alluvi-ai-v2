// POST /v1/auth/apple and POST /v1/auth/google (document 02 section 4.1).
//
// The phone has already talked to Apple or Google and holds an identity
// token. We verify it (src/auth/identity-token.ts), and the verified
// identity goes through the same sign-in rules as a magic link (sign-in.ts).
// The two routes differ only in which verifier they use.

import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { AccessTokenService } from '../../auth/access-token.js';
import type { IdentityTokenVerifier } from '../../auth/identity-token.js';
import type { AccountStore, AuthProvider } from '../../db/account-store.js';
import type { DeviceStore } from '../../db/device-store.js';
import { AppError } from '../../http/errors.js';
import { byIp, MINUTE } from '../../http/rate-limit.js';
import { readTimeZone } from '../../http/time-zone.js';
import { validate } from '../../http/validate.js';
import { consentsField, installIdField, resolveDevice, toConsentDecisions } from './shared.js';
import { createSignInService } from './sign-in.js';

// A verifier per provider. Undefined means the client ids are not configured
// (APPLE_CLIENT_IDS / GOOGLE_CLIENT_IDS); the route then answers 503.
// `X | undefined` rather than `?:` because the project's
// exactOptionalPropertyTypes setting treats "present but undefined" as a
// different thing from "absent", and server.ts builds these as present-or-
// undefined (TypeScript notes, entry 38).
export interface IdentityTokenVerifiers {
  apple?: IdentityTokenVerifier | undefined;
  google?: IdentityTokenVerifier | undefined;
}

export interface SocialSignInRouteDependencies {
  identityTokens: IdentityTokenVerifiers;
  devices: DeviceStore;
  accounts: AccountStore;
  accessTokens: AccessTokenService;
  now?: () => Date;
}

const bodySchema = z.strictObject({
  identity_token: z.string().min(1).max(8192),
  nonce: z.string().min(1).max(256).optional(),
  device_install_id: installIdField,
  guest_session_id: z.uuid().nullable().optional(),
  consents: consentsField,
  // Apple sends the name to the app, not in the token, and only on the very
  // first sign-in; the app forwards it here. Used only when creating.
  given_name: z.string().max(50).nullable().optional(),
  family_name: z.string().max(50).nullable().optional(),
});

export function socialSignInRoutes(deps: SocialSignInRouteDependencies): FastifyPluginCallback {
  const now = deps.now ?? (() => new Date());
  const signIn = createSignInService({
    accounts: deps.accounts,
    accessTokens: deps.accessTokens,
    now,
  });

  return (app, _options, done) => {
    // One registration per provider; the handler is the same.
    const providers: {
      path: string;
      provider: AuthProvider;
      verifier: IdentityTokenVerifier | undefined;
    }[] = [
      { path: '/auth/apple', provider: 'apple', verifier: deps.identityTokens.apple },
      { path: '/auth/google', provider: 'google', verifier: deps.identityTokens.google },
    ];

    for (const { path, provider, verifier } of providers) {
      app.post(
        path,
        {
          config: {
            auth: 'public',
            // Document 03 section 5: 20 per 10 minutes per IP.
            rateLimits: [
              { name: `auth.${provider}.ip`, limit: 20, windowMs: 10 * MINUTE, keyOf: byIp },
            ],
          },
        },
        async (request, reply) => {
          const body = validate(bodySchema, request.body);
          const timeZone = readTimeZone(request.headers);
          if (verifier === undefined) {
            request.log.error(`${provider} sign-in is not configured`);
            throw new AppError('service_unavailable');
          }

          const identity = await verifier.verify(body.identity_token, body.nonce);
          const device = await resolveDevice(deps.devices, body.device_install_id);

          const result = await signIn.signIn({
            provider,
            subject: identity.subject,
            email: identity.email,
            // The token's name wins; the body's is the fallback (Apple).
            givenName: identity.givenName ?? body.given_name ?? null,
            familyName: identity.familyName ?? body.family_name ?? null,
            consents: toConsentDecisions(body.consents),
            guestSessionId: body.guest_session_id ?? null,
            deviceId: device.id,
            timeZone,
            ip: request.ip,
          });
          return reply.code(result.status).send(result.body);
        },
      );
    }

    done();
  };
}
