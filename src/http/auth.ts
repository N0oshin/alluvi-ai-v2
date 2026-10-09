// Authentication middleware: who is making this request?
//
// Every request may carry `Authorization: Bearer <token>`. The token is one
// of two kinds, told apart by its prefix:
//   - an access token (a JWT): checked by signature,
//     no database. The caller is a `user`.
//   - a guest token (`gst_...`): looked up in
//     guest_sessions. The caller is a `guest` doing onboarding.
// No header means `anonymous`.
//
// The result is the request's *principal*, which later code reads instead of
// touching tokens again. Each route says who may call it with
// `config: { auth: 'user' | 'guest' | 'user_or_guest' | 'public' }`; a route
// that says nothing is public.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccessTokenService } from '../auth/access-token.js';
import type { GuestSessionStore } from '../db/guest-session-store.js';
import { AppError } from './errors.js';

export interface UserPrincipal {
  kind: 'user';
  userId: string;
  sessionId: string;
}

export interface GuestPrincipal {
  kind: 'guest';
  guestSessionId: string;
  deviceId: string;
}

export interface AnonymousPrincipal {
  kind: 'anonymous';
}

export type Principal = UserPrincipal | GuestPrincipal | AnonymousPrincipal;

export type AuthRequirement = 'public' | 'user' | 'guest' | 'user_or_guest';

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: AuthRequirement;
  }
  interface FastifyRequest {
    principal: Principal;
  }
}

export interface AuthOptions {
  accessTokens: AccessTokenService;
  guestSessions: GuestSessionStore;
  now?: () => Date;
}

const GUEST_PREFIX = 'gst_';

// This pulls the token out of an Authorization header
export function readBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || rest.length > 0) {
    throw new AppError('unauthenticated');
  }
  return token;
}

function satisfies(requirement: AuthRequirement, principal: Principal): boolean {
  switch (requirement) {
    case 'public':
      return true;
    case 'user':
      return principal.kind === 'user';
    case 'guest':
      return principal.kind === 'guest';
    case 'user_or_guest':
      return principal.kind === 'user' || principal.kind === 'guest';
  }
}

export function addAuthentication(app: FastifyInstance, options: AuthOptions): void {
  const { accessTokens, guestSessions } = options;
  const now = options.now ?? (() => new Date());

  // Registers the field with no starting value. The hook below assigns it on
  // every request before any handler runs, so handlers never see it unset.
  app.decorateRequest('principal');

  // onRequest is the earliest hook: before the body is parsed and before the
  // rate limit and idempotency hooks, which both want to know the caller.
  app.addHook('onRequest', async (request) => {
    const requirement = request.routeOptions.config.auth ?? 'public';
    const token = readBearerToken(request.headers.authorization);

    let principal: Principal = { kind: 'anonymous' };
    if (token !== undefined) {
      if (token.startsWith(GUEST_PREFIX)) {
        const guest = await guestSessions.resolve(token, now());
        principal = { kind: 'guest', guestSessionId: guest.id, deviceId: guest.deviceId };
      } else {
        const claims = await accessTokens.verify(token);
        principal = { kind: 'user', userId: claims.userId, sessionId: claims.sessionId };
      }
    }
    request.principal = principal;

    if (!satisfies(requirement, principal)) {
      throw new AppError('unauthenticated');
    }
  });
}

// For handlers on `auth: 'user'` routes: the principal, typed as a user.
// The hook has already refused anyone else, so the throw is a safety net.
export function requireUser(request: FastifyRequest): UserPrincipal {
  if (request.principal.kind !== 'user') throw new AppError('unauthenticated');
  return request.principal;
}

export function requireGuest(request: FastifyRequest): GuestPrincipal {
  if (request.principal.kind !== 'guest') throw new AppError('unauthenticated');
  return request.principal;
}
