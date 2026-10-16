// The identity module's HTTP routes.
//
//   POST /v1/guest-sessions                       first launch: register the device, get a guest token
//   POST /v1/auth/token/refresh                   trade a refresh token for a new pair
//   POST /v1/auth/logout                          end the current session
//   POST /v1/auth/apple, /v1/auth/google          social sign-in with a verified identity token
//   POST /v1/auth/email/magic-links               send me a sign-in link
//   POST /v1/auth/email/magic-links/open          the browser page's confirm button
//   POST /v1/auth/email/magic-links/{id}/claim    the app polls this every 3 seconds
//   GET  <MAGIC_LINK_BASE_URL>?token=mlt_...      the page the email opens (outside /v1)
//
// Routes validate, call queries, and answer. The sign-in decision itself is
// in sign-in.ts.

import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config/index.js';
import type { Providers } from '../../providers/index.js';
import { ACCESS_TOKEN_LIFETIME_SECONDS, accessTokens } from '../../shared/auth/access-token.js';
import type { IdentityTokenVerifier } from '../../shared/auth/identity-token.js';
import {
  MAGIC_LINK_LIFETIME_MS,
  MAGIC_LINK_RESEND_COOLDOWN_SECONDS,
} from '../../shared/auth/magic-link-token.js';
import { requireUser } from '../../shared/http/auth.js';
import { AppError, type ErrorCode } from '../../shared/http/errors.js';
import { byIp, HOUR, MINUTE, SECOND } from '../../shared/http/rate-limit.js';
import { readTimeZone } from '../../shared/http/time-zone.js';
import { validate } from '../../shared/http/validate.js';
import { AUDIT_ACTIONS, recordAudit } from '../../shared/infrastructure/audit.js';
import { isEmailSuppressed } from '../email/index.js';
import { magicLinkEmail, magicLinkPage, type MagicLinkPageState } from './magic-link.js';
import {
  type AuthProvider,
  clearPushToken,
  type ConsentDecision,
  consumeMagicLink,
  createGuestSession,
  createMagicLink,
  deleteMagicLink,
  type Device,
  findDeviceByInstallId,
  findMagicLinkById,
  findSession,
  findUserByEmail,
  type IssuedSession,
  type MagicLink,
  openMagicLink,
  peekMagicLink,
  registerDevice,
  revokeSession,
  rotateSession,
} from './queries.js';
import { consentTypeEnum, magicIntentEnum, platformEnum } from '../../shared/schema.js';
import { signIn, type SignInResult } from './sign-in.js';

// How often the app should call claim while the link is pending.
export const MAGIC_LINK_POLL_INTERVAL_SECONDS = 3;

// ---------------------------------------------------------------------------
// Fields and helpers shared by the sign-in routes

const installIdField = z.string().min(8).max(128);

// One checkbox from screen 119.
const consentSchema = z.strictObject({
  type: z.enum(consentTypeEnum.enumValues),
  version: z.string().min(1).max(50),
  granted: z.boolean(),
});
const consentsField = z.array(consentSchema).max(10).default([]);

// API shape (version) to code shape (documentVersion).
const toConsentDecisions = (consents: z.infer<typeof consentSchema>[]): ConsentDecision[] =>
  consents.map((c) => ({ type: c.type, documentVersion: c.version, granted: c.granted }));

// The device behind an install id, or 422 on the field: the phone must have
// called POST /v1/guest-sessions first.
async function resolveDevice(installId: string): Promise<Device> {
  const device = await findDeviceByInstallId(installId);
  if (device === undefined) {
    throw new AppError('validation_failed', [
      {
        field: 'device_install_id',
        code: 'unknown_device',
        message: 'Register the install with POST /v1/guest-sessions first.',
      },
    ]);
  }
  return device;
}

const emailSchema = z.email();

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) throw new AppError('invalid_email');
  return email;
}

const secondsUntil = (instant: Date, now: Date) =>
  Math.max(0, Math.ceil((instant.getTime() - now.getTime()) / SECOND));

// ---------------------------------------------------------------------------
// Audit (document 03 section 5: sign-ins, failed sign-ins, consent changes)

// The refusals that count as a failed sign-in. Left out on purpose:
// validation_failed and invalid_email (a bug in the app, not someone
// guessing), service_unavailable (our fault), and rate_limited (refused
// before the handler runs).
const SIGN_IN_FAILURES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'unauthenticated',
  'invalid_identity_token',
  'magic_link_invalid',
  'magic_link_expired',
  'magic_link_already_used',
  'account_suspended',
  'email_linked_to_other_provider',
  'consent_required',
]);

interface SignInOutcome {
  result: SignInResult;
  deviceId: string;
  // What the person ticked; recorded when the call created the account.
  consents: ConsentDecision[];
}

async function auditSignInFailure(
  request: FastifyRequest,
  provider: AuthProvider,
  error: unknown,
): Promise<void> {
  if (!(error instanceof AppError) || !SIGN_IN_FAILURES.has(error.code)) return;
  await recordAudit(
    {
      action: AUDIT_ACTIONS.signInFailed,
      requestId: request.id,
      ip: request.ip,
      metadata: { provider, code: error.code },
    },
    request.log,
  );
}

// Wraps the end of every sign-in route: a signed-in result is recorded as a
// sign-in or sign-up (plus the consents on sign-up); a refusal from the list
// above as a failed sign-in. The error is rethrown either way.
async function withSignInAudit(
  request: FastifyRequest,
  provider: AuthProvider,
  run: () => Promise<SignInOutcome>,
): Promise<SignInResult> {
  const where = { requestId: request.id, ip: request.ip };

  let outcome: SignInOutcome;
  try {
    outcome = await run();
  } catch (error) {
    await auditSignInFailure(request, provider, error);
    throw error;
  }

  const { result, deviceId, consents } = outcome;
  const actorUserId = result.body.user.id;
  const created = result.status === 201;

  await recordAudit(
    {
      action: created ? AUDIT_ACTIONS.signUp : AUDIT_ACTIONS.signIn,
      actorUserId,
      deviceId,
      ...where,
      metadata: { provider },
    },
    request.log,
  );

  if (created) {
    await recordAudit(
      {
        action: AUDIT_ACTIONS.consentRecorded,
        actorUserId,
        deviceId,
        ...where,
        metadata: {
          consents: consents.map((c) => ({
            type: c.type,
            version: c.documentVersion,
            granted: c.granted,
          })),
        },
      },
      request.log,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Request schemas

const guestSessionSchema = z.strictObject({
  device: z.strictObject({
    platform: z.enum(platformEnum.enumValues),
    app_version: z.string().min(1).max(50),
    os_version: z.string().min(1).max(50),
    install_id: installIdField,
  }),
});

const refreshSchema = z.strictObject({
  refresh_token: z.string().min(1).max(256),
});

const socialSchema = z.strictObject({
  identity_token: z.string().min(1).max(8192),
  nonce: z.string().min(1).max(256).optional(),
  device_install_id: installIdField,
  guest_session_id: z.uuid().nullable().optional(),
  consents: consentsField,
  given_name: z.string().max(50).nullable().optional(),
  family_name: z.string().max(50).nullable().optional(),
});

// The address is taken as any string here and checked separately, so a bad
// address is 422 invalid_email rather than validation_failed.
const magicLinkRequestSchema = z.strictObject({
  email: z.string().min(3).max(254),
  intent: z.enum(magicIntentEnum.enumValues),
  device_install_id: installIdField,
  guest_session_id: z.uuid().nullable().optional(),
});

const magicLinkOpenSchema = z.strictObject({
  token: z.string().min(1).max(256),
});

const claimParamsSchema = z.object({ id: z.uuid() });

const claimSchema = z.strictObject({
  device_install_id: installIdField,
  // Needed only when an account is created.
  consents: consentsField,
});

// Rate limit keys read from the body or params.
const byInstallId = (request: FastifyRequest): string | undefined => {
  const parsed = guestSessionSchema.safeParse(request.body);
  return parsed.success ? parsed.data.device.install_id : undefined;
};
const byEmail = (request: FastifyRequest): string | undefined => {
  const parsed = magicLinkRequestSchema.safeParse(request.body);
  return parsed.success ? parsed.data.email.trim().toLowerCase() : undefined;
};
const byRequestId = (request: FastifyRequest): string | undefined => {
  const parsed = claimParamsSchema.safeParse(request.params);
  return parsed.success ? parsed.data.id : undefined;
};
const byUser = (request: FastifyRequest): string | undefined =>
  request.principal.kind === 'user' ? request.principal.userId : undefined;

// ---------------------------------------------------------------------------
// The /v1 routes

export function identityRoutes(providers: Providers): FastifyPluginCallback {
  return (app, _options, done) => {
    // --- Guest sessions -------------------------------------------------

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
        const { device } = validate(guestSessionSchema, request.body);
        const now = new Date();

        const registered = await registerDevice(
          {
            installId: device.install_id,
            platform: device.platform,
            appVersion: device.app_version,
            osVersion: device.os_version,
          },
          now,
        );
        const { guestSession, guestToken } = await createGuestSession(registered.id, now);

        return reply.code(201).send({
          guest_session_id: guestSession.id,
          guest_token: guestToken,
          expires_at: guestSession.expiresAt.toISOString(),
        });
      },
    );

    // --- Sessions (document 02 sections 4.4 and 4.5) ---------------------

    // Public because the caller has no valid access token; the refresh token
    // in the body is the proof.
    app.post(
      '/auth/token/refresh',
      {
        config: {
          auth: 'public',
          // A phone refreshes about once per 15 minutes; 30 per 10 minutes
          // per IP leaves room for a shared network and stops brute force.
          rateLimits: [{ name: 'auth.refresh.ip', limit: 30, windowMs: 10 * MINUTE, keyOf: byIp }],
        },
      },
      async (request) => {
        const body = validate(refreshSchema, request.body);
        let rotated: IssuedSession;
        try {
          rotated = await rotateSession(body.refresh_token, new Date());
        } catch (error) {
          // A replayed token means it was copied: worth a row of its own. The
          // session is already revoked; the user is unknown here.
          if (error instanceof AppError && error.code === 'refresh_token_reused') {
            await recordAudit(
              { action: AUDIT_ACTIONS.refreshReuse, requestId: request.id, ip: request.ip },
              request.log,
            );
          }
          throw error;
        }
        const { session, refreshToken } = rotated;
        const accessToken = await accessTokens.issue({
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
          rateLimits: [{ name: 'auth.logout.user', limit: 10, windowMs: MINUTE, keyOf: byUser }],
        },
      },
      async (request, reply) => {
        const { userId, sessionId } = requireUser(request);
        const now = new Date();
        // The access token named the session; the session names the device.
        const session = await findSession(sessionId);
        await revokeSession(sessionId, now);
        if (session !== undefined) {
          await clearPushToken(session.deviceId, now);
        }
        await recordAudit(
          {
            action: AUDIT_ACTIONS.logout,
            actorUserId: userId,
            targetType: 'session',
            targetId: sessionId,
            deviceId: session?.deviceId ?? null,
            requestId: request.id,
            ip: request.ip,
          },
          request.log,
        );
        return reply.code(204).send();
      },
    );

    // --- Apple and Google (document 02 section 4.1) ----------------------

    // The phone has already talked to Apple or Google and holds an identity
    // token. It is verified here, and the verified identity goes through the
    // same sign-in rules as a magic link. The two routes differ only in
    // which verifier they use.
    const social: {
      path: string;
      provider: AuthProvider;
      verifier: IdentityTokenVerifier | undefined;
    }[] = [
      { path: '/auth/apple', provider: 'apple', verifier: providers.identityTokens.apple },
      { path: '/auth/google', provider: 'google', verifier: providers.identityTokens.google },
    ];

    for (const { path, provider, verifier } of social) {
      app.post(
        path,
        {
          config: {
            auth: 'public',
            rateLimits: [
              { name: `auth.${provider}.ip`, limit: 20, windowMs: 10 * MINUTE, keyOf: byIp },
            ],
          },
        },
        async (request, reply) => {
          const result = await withSignInAudit(request, provider, async () => {
            const body = validate(socialSchema, request.body);
            const timeZone = readTimeZone(request.headers);
            if (verifier === undefined) {
              request.log.error(`${provider} sign-in is not configured`);
              throw new AppError('service_unavailable');
            }

            const identity = await verifier.verify(body.identity_token, body.nonce);
            const device = await resolveDevice(body.device_install_id);
            const consents = toConsentDecisions(body.consents);

            const signedIn = await signIn({
              provider,
              subject: identity.subject,
              email: identity.email,
              // The token's name wins; the body's is the fallback (Apple).
              givenName: identity.givenName ?? body.given_name ?? null,
              familyName: identity.familyName ?? body.family_name ?? null,
              consents,
              guestSessionId: body.guest_session_id ?? null,
              deviceId: device.id,
              timeZone,
              ip: request.ip,
            });
            return { result: signedIn, deviceId: device.id, consents };
          });
          return reply.code(result.status).send(result.body);
        },
      );
    }

    // --- Email magic links (document 02 sections 4.2 to 4.4) -------------

    // The app asks for a link and is given a request id. The person opens the
    // email wherever they like; the page asks them to confirm, and confirming
    // marks the link opened. The app's next claim call consumes the link and
    // signs in. Tokens only ever go to the install that asked for the link.
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
        const body = validate(magicLinkRequestSchema, request.body);
        const email = normalizeEmail(body.email);
        const device = await resolveDevice(body.device_install_id);
        const now = new Date();

        // An address that bounced or complained gets no more mail from us.
        if (await isEmailSuppressed(email)) throw new AppError('email_undeliverable');

        // Signing in to an address with no account says so (decision 35).
        if (body.intent === 'sign_in') {
          const owner = await findUserByEmail(email);
          if (owner === undefined) throw new AppError('account_not_found');
        }

        const { link, token } = await createMagicLink(
          {
            email,
            intent: body.intent,
            guestSessionId: body.guest_session_id ?? null,
            requestedDeviceId: device.id,
            requestedIp: request.ip,
          },
          now,
        );

        const url = new URL(config.MAGIC_LINK_BASE_URL);
        url.searchParams.set('token', token);
        try {
          await providers.email.send(
            magicLinkEmail({
              to: email,
              link: url.toString(),
              intent: body.intent,
              expiresInMinutes: MAGIC_LINK_LIFETIME_MS / MINUTE,
            }),
          );
        } catch (error) {
          // A link nobody received must not sit there usable.
          await deleteMagicLink(link.id);
          request.log.error({ err: error }, 'magic link email could not be sent');
          throw new AppError('service_unavailable');
        }

        return reply.code(202).send({
          sent: true,
          resend_available_in: MAGIC_LINK_RESEND_COOLDOWN_SECONDS,
          request_id: link.id,
          poll_interval: MAGIC_LINK_POLL_INTERVAL_SECONDS,
          expires_in: secondsUntil(link.expiresAt, now),
        });
      },
    );

    // The browser page's button. Marks the link opened; nothing is signed in
    // here. A bad token presented here is still someone guessing, so it is
    // recorded as a failed sign-in.
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
        const body = validate(magicLinkOpenSchema, request.body);
        let link: MagicLink;
        try {
          link = await openMagicLink(body.token, new Date());
        } catch (error) {
          await auditSignInFailure(request, 'email', error);
          throw error;
        }
        return reply.send({ opened: true, intent: link.intent });
      },
    );

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
        const device = await resolveDevice(body.device_install_id);
        const now = new Date();

        // Unknown, or asked for by another install: the same 404 for both, so
        // nobody can tell which (backend notes, entry 56).
        const link = await findMagicLinkById(params.id);
        if (link === undefined || link.requestedDeviceId !== device.id) {
          throw new AppError('not_found');
        }
        if (link.consumedAt !== null) throw new AppError('magic_link_already_used');
        if (link.expiresAt <= now) throw new AppError('magic_link_expired');

        // A polled answer must never come from a cache.
        void reply.header('Cache-Control', 'no-store');

        if (link.openedAt === null) {
          return reply.send({
            status: 'pending',
            poll_interval: MAGIC_LINK_POLL_INTERVAL_SECONDS,
            expires_in: secondsUntil(link.expiresAt, now),
          });
        }

        const result = await withSignInAudit(request, 'email', async () => {
          const consumed = await consumeMagicLink(link.id, now);
          const consents = toConsentDecisions(body.consents);
          const signedIn = await signIn({
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

// ---------------------------------------------------------------------------
// The browser page, outside /v1, at the path of MAGIC_LINK_BASE_URL. It only
// looks at the token (peek) to pick which message to show; the button on it
// is what changes anything.

export function magicLinkPageRoutes(): FastifyPluginCallback {
  const path = new URL(config.MAGIC_LINK_BASE_URL).pathname;

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
            const link = await peekMagicLink(token, new Date());
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
