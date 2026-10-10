// Email sign-in by magic link (document 02 sections 4.2 and 4.3).
//
//   POST /v1/auth/email/magic-links           screen 126: send me a link
//   POST /v1/auth/email/magic-links/consume   the app opened the link
//
// The request stores a hashed single-use token bound to the install that
// asked, and emails the link. Consuming it proves the person owns the inbox,
// and from there the shared sign-in rules take over (sign-in.ts). Backend
// notes, entry 44.

import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccessTokenService } from '../../auth/access-token.js';
import {
  MAGIC_LINK_LIFETIME_MS,
  MAGIC_LINK_RESEND_COOLDOWN_SECONDS,
} from '../../auth/magic-link-token.js';
import type { AccountStore } from '../../db/account-store.js';
import type { DeviceStore } from '../../db/device-store.js';
import type { EmailSuppressionStore } from '../../db/email-suppression-store.js';
import type { MagicLinkStore } from '../../db/magic-link-store.js';
import { magicIntentEnum } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { byIp, HOUR, MINUTE, SECOND } from '../../http/rate-limit.js';
import { readTimeZone } from '../../http/time-zone.js';
import { validate } from '../../http/validate.js';
import type { EmailProvider } from '../../providers/email/index.js';
import { magicLinkEmail } from './magic-link-email.js';
import { consentsField, installIdField, resolveDevice, toConsentDecisions } from './shared.js';
import { createSignInService } from './sign-in.js';

export interface MagicLinkRouteDependencies {
  magicLinks: MagicLinkStore;
  devices: DeviceStore;
  accounts: AccountStore;
  accessTokens: AccessTokenService;
  email: EmailProvider;
  emailSuppressions: EmailSuppressionStore;
  // MAGIC_LINK_BASE_URL; the token is appended as ?token=...
  magicLinkBaseUrl: string;
  now?: () => Date;
}

// The address is taken as any string here and checked separately, so a bad
// address is 422 invalid_email (document 02) rather than validation_failed.
const requestSchema = z.strictObject({
  email: z.string().min(3).max(254),
  intent: z.enum(magicIntentEnum.enumValues),
  device_install_id: installIdField,
  guest_session_id: z.uuid().nullable().optional(),
});

const emailSchema = z.email();

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) throw new AppError('invalid_email');
  return email;
}

const consumeSchema = z.strictObject({
  token: z.string().min(1).max(256),
  device_install_id: installIdField,
  // Needed only when an account is created; screen 119's checkboxes.
  consents: consentsField,
  // Set after the person confirms opening a link requested on another install.
  confirm_device: z.boolean().default(false),
});

// Rate limit key: the requested address, when the body has one.
const byEmail = (request: FastifyRequest): string | undefined => {
  const parsed = requestSchema.safeParse(request.body);
  return parsed.success ? parsed.data.email.trim().toLowerCase() : undefined;
};

export function magicLinkRoutes(deps: MagicLinkRouteDependencies): FastifyPluginCallback {
  const now = deps.now ?? (() => new Date());
  const signIn = createSignInService({
    accounts: deps.accounts,
    accessTokens: deps.accessTokens,
    now,
  });

  const deviceFor = (installId: string) => resolveDevice(deps.devices, installId);

  return (app, _options, done) => {
    //   1. Validate the body, normalise the email, find the device.
    //   2. If intent is sign_in, check an account exists for this email.
    //   3. magicLinks.create(...) with everything we know.
    //   4. Build the URL: take MAGIC_LINK_BASE_URL, add ?token=mlt_....
    //   5. Send the email. If the provider throws, delete the link we just made and answer 503.
    //   6. Answer 202 with { sent: true, resend_available_in: 30 }.
    app.post(
      '/auth/email/magic-links',
      {
        config: {
          auth: 'public',
          rateLimits: [
            {
              name: 'magic_link.email.cooldown',
              limit: 1,
              windowMs: MAGIC_LINK_RESEND_COOLDOWN_SECONDS * SECOND,
              keyOf: byEmail,
            },
            { name: 'magic_link.email.hour', limit: 5, windowMs: HOUR, keyOf: byEmail },
            { name: 'magic_link.ip', limit: 20, windowMs: HOUR, keyOf: byIp },
          ],
        },
      },
      async (request, reply) => {
        const body = validate(requestSchema, request.body);
        const email = normalizeEmail(body.email);
        const device = await deviceFor(body.device_install_id);
        const at = now();

        // An address that bounced or complained gets no more mail from us.
        if (await deps.emailSuppressions.isSuppressed(email)) {
          throw new AppError('email_undeliverable');
        }

        // Screen 128: signing in to an address with no account says so.
        if (body.intent === 'sign_in') {
          const owner = await deps.accounts.findUserByEmail(email);
          if (owner === undefined) throw new AppError('account_not_found');
        }

        const { link, token } = await deps.magicLinks.create(
          {
            email,
            intent: body.intent,
            guestSessionId: body.guest_session_id ?? null,
            requestedDeviceId: device.id,
            requestedIp: request.ip,
          },
          at,
        );

        const url = new URL(deps.magicLinkBaseUrl);
        url.searchParams.set('token', token);
        try {
          await deps.email.send(
            magicLinkEmail({
              to: email,
              link: url.toString(),
              intent: body.intent,
              expiresInMinutes: MAGIC_LINK_LIFETIME_MS / MINUTE,
            }),
          );
        } catch (error) {
          // A link nobody received must not sit there usable. Remove it and
          // tell the phone to try again shortly.
          await deps.magicLinks.delete(link.id);
          request.log.error({ err: error }, 'magic link email could not be sent');
          throw new AppError('service_unavailable');
        }

        return reply
          .code(202)
          .send({ sent: true, resend_available_in: MAGIC_LINK_RESEND_COOLDOWN_SECONDS });
      },
    );

    //  1. Validate the body, read X-Time-Zone (a new user row needs it), find the device.
    //  2. peek the link. This throws for invalid, used or expired, without touching the row.
    //  3. Device check: if the link was requested from a different install and confirm_device is false, throw magic_link_other_device. The link is still unused, so the app can ask "Continue on this device?" and call again with confirm_device: true.
    //  4. consume the link. Now it is used up.
    //  5. Build a SignInInput with provider: 'email', the address as both subjet and email, no name, the consents from the body, the guest session from the link, the device, the time zone, the IP. Call signIn.
    //  6. Send whatever signIn returned: 201 and confirm_name for a new account, 200 for an existing one.
    app.post(
      '/auth/email/magic-links/consume',
      {
        config: {
          auth: 'public',
          rateLimits: [
            { name: 'magic_link.consume.ip', limit: 10, windowMs: 10 * MINUTE, keyOf: byIp },
          ],
        },
      },
      async (request, reply) => {
        const body = validate(consumeSchema, request.body);
        const timeZone = readTimeZone(request.headers);
        const device = await deviceFor(body.device_install_id);
        const at = now();

        // Look before using: a link opened on another install is refused
        // without being used up, so the person can confirm and retry.
        const pending = await deps.magicLinks.peek(body.token, at);
        if (pending.requestedDeviceId !== device.id && !body.confirm_device) {
          throw new AppError('magic_link_other_device');
        }

        const link = await deps.magicLinks.consume(body.token, at);
        const result = await signIn.signIn({
          provider: 'email',
          subject: link.email,
          email: link.email,
          givenName: null,
          familyName: null,
          consents: toConsentDecisions(body.consents),
          guestSessionId: link.guestSessionId,
          deviceId: device.id,
          timeZone,
          ip: request.ip,
        });
        return reply.code(result.status).send(result.body);
      },
    );

    done();
  };
}
