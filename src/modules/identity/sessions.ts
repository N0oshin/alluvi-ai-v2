// The session routes (document 02 sections 4.4 and 4.5).
//
//   POST /v1/auth/token/refresh   the phone's access token has expired; it
//                                 trades its refresh token for a new pair.
//   POST /v1/auth/logout          screen 52; ends the current session and
//                                 stops pushes to this phone.
//
// Both are thin: rotation, reuse detection and revocation live in the
// session store (backend notes, entry 39). Refresh is public because the
// caller has no valid access token; the refresh token in the body is the
// proof. Logout needs a signed-in user.

import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { ACCESS_TOKEN_LIFETIME_SECONDS, type AccessTokenService } from '../../auth/access-token.js';
import type { DeviceStore } from '../../db/device-store.js';
import type { SessionStore } from '../../db/session-store.js';
import { requireUser } from '../../http/auth.js';
import { byIp, MINUTE } from '../../http/rate-limit.js';
import { validate } from '../../http/validate.js';

export interface SessionRouteDependencies {
  sessions: SessionStore;
  devices: DeviceStore;
  accessTokens: AccessTokenService;
  now?: () => Date;
}

const refreshSchema = z.strictObject({
  refresh_token: z.string().min(1).max(256),
});

export function sessionRoutes(deps: SessionRouteDependencies): FastifyPluginCallback {
  const now = deps.now ?? (() => new Date());

  return (app, _options, done) => {
    app.post(
      '/auth/token/refresh',
      {
        config: {
          auth: 'public',
          // A phone refreshes about once per 15 minutes; 30 per 10 minutes
          // per IP leaves room for a shared network and stops brute force [A].
          rateLimits: [{ name: 'auth.refresh.ip', limit: 30, windowMs: 10 * MINUTE, keyOf: byIp }],
        },
      },
      async (request) => {
        const body = validate(refreshSchema, request.body);
        // Throws 401 unauthenticated for an unknown, expired or revoked token
        // and 401 refresh_token_reused (revoking the session) for a replay.
        const { session, refreshToken } = await deps.sessions.rotate(body.refresh_token, now());
        const accessToken = await deps.accessTokens.issue({
          userId: session.userId,
          sessionId: session.id,
        });
        return {
          access_token: accessToken,
          access_expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
          refresh_token: refreshToken,
        };
      },
    );

    app.post(
      '/auth/logout',
      {
        config: {
          auth: 'user',
          rateLimits: [
            {
              name: 'auth.logout.user',
              limit: 10,
              windowMs: MINUTE,
              keyOf: (request) =>
                request.principal.kind === 'user' ? request.principal.userId : undefined,
            },
          ],
        },
      },
      async (request, reply) => {
        const { sessionId } = requireUser(request);
        const at = now();
        // The access token named the session; the session names the device.
        const session = await deps.sessions.find(sessionId);
        await deps.sessions.revoke(sessionId, at);
        if (session !== undefined) {
          await deps.devices.clearPushToken(session.deviceId, at);
        }
        // 204 No Content: done, nothing to say.
        return reply.code(204).send();
      },
    );

    done();
  };
}
