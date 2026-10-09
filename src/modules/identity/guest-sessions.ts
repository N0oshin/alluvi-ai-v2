// POST /v1/guest-sessions. Registers the device and issues a guest token that the onboarding routes accept until an account exists.
//
// // Validate the body against the zod schema you selected.
// Upsert the device into devices.
// Insert a guest_sessions row linked to that device and issue the token.
// Return 201 with the token.

import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DeviceStore } from '../../db/device-store.js';
import type { GuestSessionStore } from '../../db/guest-session-store.js';
import { platformEnum } from '../../db/schema/index.js';
import { byIp, HOUR } from '../../http/rate-limit.js';
import { validate } from '../../http/validate.js';

export interface GuestSessionRouteDependencies {
  devices: DeviceStore;
  guestSessions: GuestSessionStore;
  now?: () => Date;
}

// The request body. `platformEnum.enumValues` is the ['ios', 'android'] list
// from the schema, so the API and the database column cannot disagree.
const bodySchema = z.strictObject({
  device: z.strictObject({
    platform: z.enum(platformEnum.enumValues),
    app_version: z.string().min(1).max(50),
    os_version: z.string().min(1).max(50),
    install_id: z.string().min(8).max(128),
  }),
});

// It tries to read the body with the form above. If successful, return the install id. If not, return undefined
const byInstallId = (request: FastifyRequest): string | undefined => {
  const parsed = bodySchema.safeParse(request.body);
  return parsed.success ? parsed.data.device.install_id : undefined;
};

export function guestSessionRoutes(deps: GuestSessionRouteDependencies): FastifyPluginCallback {
  const now = deps.now ?? (() => new Date());

  return (app, _options, done) => {
    app.post(
      '/guest-sessions',
      {
        config: {
          auth: 'public',
          idempotent: true,
          rateLimits: [
            { name: 'guest_sessions.ip', limit: 10, windowMs: HOUR, keyOf: byIp },
            { name: 'guest_sessions.install', limit: 10, windowMs: HOUR, keyOf: byInstallId },
          ],
        },
      },
      async (request, reply) => {
        const { device } = validate(bodySchema, request.body);
        const at = now();

        const registered = await deps.devices.register(
          {
            installId: device.install_id,
            platform: device.platform,
            appVersion: device.app_version,
            osVersion: device.os_version,
          },
          at,
        );
        const { guestSession, guestToken } = await deps.guestSessions.create(registered.id, at);

        return reply.code(201).send({
          guest_session_id: guestSession.id,
          guest_token: guestToken,
          expires_at: guestSession.expiresAt.toISOString(),
        });
      },
    );

    done();
  };
}
