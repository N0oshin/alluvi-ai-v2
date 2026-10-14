// Email sign-in by magic link (document 02 sections 4.2 to 4.4, decision 51).
//
//   POST /v1/auth/email/magic-links              screen 126: send me a link
//   GET  <MAGIC_LINK_BASE_URL>?token=mlt_...     the page the email opens, in any browser
//   POST /v1/auth/email/magic-links/open         the page's "Yes, sign me in" button
//   POST /v1/auth/email/magic-links/{id}/claim   the app polls this every 3 seconds
//
// The app asks for a link and is given a request id. The person opens the
// email wherever they like; the page asks them to confirm, and confirming
// marks the link opened. The app's next claim call consumes the link and
// signs in through the shared rules (sign-in.ts). Tokens only ever go to the
// install that asked for the link, so a link seen by anyone else is useless
// to them. Backend notes, entry 57.

import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccessTokenService } from '../../auth/access-token.js';
import {
  MAGIC_LINK_LIFETIME_MS,
  MAGIC_LINK_RESEND_COOLDOWN_SECONDS,
} from '../../auth/magic-link-token.js';
import type { AccountStore } from '../../db/account-store.js';
import type { AuditStore } from '../../db/audit-store.js';
import type { DeviceStore } from '../../db/device-store.js';
import type { EmailSuppressionStore } from '../../db/email-suppression-store.js';
import type { MagicLink, MagicLinkStore } from '../../db/magic-link-store.js';
import { magicIntentEnum } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { byIp, HOUR, MINUTE, SECOND } from '../../http/rate-limit.js';
import { readTimeZone } from '../../http/time-zone.js';
import { validate } from '../../http/validate.js';
import type { EmailProvider } from '../../providers/email/index.js';
import { magicLinkEmail } from './magic-link-email.js';
import { magicLinkPage, type MagicLinkPageState } from './magic-link-page.js';
import { auditSignInFailure, withSignInAudit } from './audit.js';
import { consentsField, installIdField, resolveDevice, toConsentDecisions } from './shared.js';
import { createSignInService } from './sign-in.js';

// How often the app should call claim while the link is pending.
export const MAGIC_LINK_POLL_INTERVAL_SECONDS = 3;

export interface MagicLinkRouteDependencies {
  magicLinks: MagicLinkStore;
  devices: DeviceStore;
  accounts: AccountStore;
  accessTokens: AccessTokenService;
  audit: AuditStore;
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

const openSchema = z.strictObject({
  token: z.string().min(1).max(256),
});

const claimParamsSchema = z.object({ id: z.uuid() });

const claimSchema = z.strictObject({
  device_install_id: installIdField,
  // Needed only when an account is created; screen 119's checkboxes.
  consents: consentsField,
});

// Rate limit keys.
const byEmail = (request: FastifyRequest): string | undefined => {
  const parsed = requestSchema.safeParse(request.body);
  return parsed.success ? parsed.data.email.trim().toLowerCase() : undefined;
};
const byRequestId = (request: FastifyRequest): string | undefined => {
  const parsed = claimParamsSchema.safeParse(request.params);
  return parsed.success ? parsed.data.id : undefined;
};

const secondsUntil = (instant: Date, now: Date) =>
  Math.max(0, Math.ceil((instant.getTime() - now.getTime()) / SECOND));

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
    //   6. Answer 202 with the request id the app will poll with.
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

        return reply.code(202).send({
          sent: true,
          resend_available_in: MAGIC_LINK_RESEND_COOLDOWN_SECONDS,
          request_id: link.id,
          poll_interval: MAGIC_LINK_POLL_INTERVAL_SECONDS,
          expires_in: secondsUntil(link.expiresAt, at),
        });
      },
    );

    // The browser page's button. Marks the link opened; nothing is signed in
    // here, so there is no device, time zone or consent to read.
    app.post(
      '/auth/email/magic-links/open',
      {
        config: {
          auth: 'public',
          rateLimits: [
            { name: 'magic_link.open.ip', limit: 10, windowMs: 10 * MINUTE, keyOf: byIp },
          ],
        },
      },
      async (request, reply) => {
        const body = validate(openSchema, request.body);
        let link: MagicLink;
        try {
          link = await deps.magicLinks.open(body.token, now());
        } catch (error) {
          await auditSignInFailure(deps.audit, request, 'email', error);
          throw error;
        }
        return reply.send({ opened: true, intent: link.intent });
      },
    );

    //  1. Validate the id and the body, read X-Time-Zone (a new user row needs it), find the device.
    //  2. Load the link by id. Unknown, or asked for by another install: 404, the same
    //     answer for both so nobody can tell which (backend notes, entry 56).
    //  3. Used or expired: say so. Not yet confirmed in the browser: answer pending.
    //  4. Consume the link. Now it is used up.
    //  5. Build a SignInInput with provider 'email', the address as both subject and
    //     email, no name, the consents from the body, the guest session from the
    //     link, the device, the time zone, the IP. Call signIn.
    //  6. Send what signIn returned under status "ready": 201 and confirm_name for
    //     a new account, 200 for an existing one.
    app.post(
      '/auth/email/magic-links/:id/claim',
      {
        config: {
          auth: 'public',
          rateLimits: [
            // A phone polling every 3 seconds makes 20 a minute; double that.
            { name: 'magic_link.claim.request', limit: 40, windowMs: MINUTE, keyOf: byRequestId },
            { name: 'magic_link.claim.ip', limit: 300, windowMs: 10 * MINUTE, keyOf: byIp },
          ],
        },
      },
      async (request, reply) => {
        const params = validate(claimParamsSchema, request.params);
        const body = validate(claimSchema, request.body);
        const timeZone = readTimeZone(request.headers);
        const device = await deviceFor(body.device_install_id);
        const at = now();

        const link = await deps.magicLinks.findById(params.id);
        if (link === undefined || link.requestedDeviceId !== device.id) {
          throw new AppError('not_found');
        }
        if (link.consumedAt !== null) throw new AppError('magic_link_already_used');
        if (link.expiresAt <= at) throw new AppError('magic_link_expired');

        // A polled answer must never come from a cache (entry 56).
        void reply.header('Cache-Control', 'no-store');

        if (link.openedAt === null) {
          return reply.send({
            status: 'pending',
            poll_interval: MAGIC_LINK_POLL_INTERVAL_SECONDS,
            expires_in: secondsUntil(link.expiresAt, at),
          });
        }

        const result = await withSignInAudit(deps.audit, request, 'email', async () => {
          const consumed = await deps.magicLinks.consume(link.id, at);
          const consents = toConsentDecisions(body.consents);
          const signedIn = await signIn.signIn({
            provider: 'email',
            subject: consumed.email,
            email: consumed.email,
            givenName: null,
            familyName: null,
            consents,
            guestSessionId: consumed.guestSessionId,
            deviceId: device.id,
            timeZone,
            ip: request.ip,
          });
          return { result: signedIn, deviceId: device.id, consents };
        });
        return reply.code(result.status).send({ status: 'ready', sign_in: result.body });
      },
    );

    done();
  };
}

export interface MagicLinkPageDependencies {
  magicLinks: MagicLinkStore;
  magicLinkBaseUrl: string;
  now?: () => Date;
}

// The page itself, outside /v1, at the path of MAGIC_LINK_BASE_URL. It only
// looks at the token (peek) to pick which message to show; the button on it
// is what changes anything.
export function magicLinkPageRoutes(deps: MagicLinkPageDependencies): FastifyPluginCallback {
  const now = deps.now ?? (() => new Date());
  const path = new URL(deps.magicLinkBaseUrl).pathname;

  const stateOf = (error: unknown): MagicLinkPageState => {
    if (error instanceof AppError) {
      if (error.code === 'magic_link_expired') return 'expired';
      if (error.code === 'magic_link_already_used') return 'used';
      if (error.code === 'magic_link_invalid') return 'invalid';
    }
    throw error;
  };

  return (app, _options, done) => {
    app.get(
      path,
      {
        config: {
          auth: 'public',
          rateLimits: [
            { name: 'magic_link.page.ip', limit: 30, windowMs: 10 * MINUTE, keyOf: byIp },
          ],
        },
      },
      async (request, reply) => {
        const query = request.query as { token?: unknown };
        const token = typeof query.token === 'string' ? query.token : '';

        let html: string;
        if (token === '') {
          html = magicLinkPage({ state: 'invalid' });
        } else {
          try {
            const link = await deps.magicLinks.peek(token, now());
            html = magicLinkPage({
              state: link.openedAt === null ? 'confirm' : 'opened',
              email: link.email,
              intent: link.intent,
            });
          } catch (error) {
            html = magicLinkPage({ state: stateOf(error) });
          }
        }
        return reply
          .type('text/html; charset=utf-8')
          .header('Cache-Control', 'no-store')
          .send(html);
      },
    );

    done();
  };
}
