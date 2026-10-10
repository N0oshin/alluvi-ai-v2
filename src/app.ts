// Builds the application without starting a network listener

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AccessTokenService } from './auth/access-token.js';
import type { AccountStore } from './db/account-store.js';
import type { DeviceStore } from './db/device-store.js';
import type { EmailSuppressionStore } from './db/email-suppression-store.js';
import type { GuestSessionStore } from './db/guest-session-store.js';
import type { MagicLinkStore } from './db/magic-link-store.js';
import type { IdentityTokenVerifiers } from './modules/identity/social-sign-in.js';
import type { SessionStore } from './db/session-store.js';
import { addAuthentication, type Principal } from './http/auth.js';
import { addErrorHandling } from './http/error-handler.js';
import { addIdempotency, type IdempotencyStore } from './http/idempotency.js';
import { RequestLogController } from './http/logging.js';
import { addRateLimiting, type RateLimitStore } from './http/rate-limit.js';
import { addRequestIdHeader, generateRequestId } from './http/request-id.js';
import type { JobPayloads } from './jobs/definitions.js';
import type { JobQueue } from './jobs/queue.js';
import type { Providers } from './providers/index.js';
import { healthRoutes, type HealthDependencies } from './routes/health.js';
import { v1Routes } from './routes/v1.js';
import { webhookRoutes } from './routes/webhooks.js';
import { wellKnownRoutes, type AppLinkConfig } from './routes/well-known.js';

// Everything the app needs from the outside world (database, and later
// storage, email and so on).
export type AppDependencies = HealthDependencies & {
  idempotencyStore: IdempotencyStore;
  rateLimitStore: RateLimitStore;
  // Background jobs the routes enqueue. Handlers run in the worker process.
  jobs: JobQueue<JobPayloads>;
  // The external services (vision, email, push, storage).
  providers: Providers;
  // Issues and verifies access tokens; resolves guest tokens (Phase 2.2).
  accessTokens: AccessTokenService;
  guestSessions: GuestSessionStore;
  devices: DeviceStore;
  // Account creation and sign-in reads (Phase 2.3).
  accounts: AccountStore;
  // Signed-in sessions: refresh and logout (Phase 2.3).
  sessions: SessionStore;
  // Email sign-in links and where they point (Phase 2.3).
  magicLinks: MagicLinkStore;
  magicLinkBaseUrl: string;
  // Apple and Google identity token verifiers, each absent when not
  // configured (Phase 2.3).
  identityTokens: IdentityTokenVerifiers;
  // Addresses that bounced or complained; written by the Resend webhook,
  // checked before sending (Phase 2.3).
  emailSuppressions: EmailSuppressionStore;
  resendWebhookSecret: string | undefined;
  // Universal Link / App Link files (Phase 2.3).
  appLinks: AppLinkConfig;
};

// Idempotency keys are scoped to the caller. Anonymous callers share one
// bucket; the only public idempotent route is POST /v1/guest-sessions, and
// keys are random UUIDs, so two phones colliding on one is not a concern.
const ANONYMOUS_SUBJECT = '00000000-0000-0000-0000-000000000000';
function subjectOf(principal: Principal): string {
  switch (principal.kind) {
    case 'user':
      return principal.userId;
    case 'guest':
      return principal.guestSessionId;
    case 'anonymous':
      return ANONYMOUS_SUBJECT;
  }
}

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
}

export function buildApp(deps: AppDependencies, options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    genReqId: generateRequestId,
    logger: options.logger ?? false,
    logController: new RequestLogController(),
  });

  addRequestIdHeader(app);

  addErrorHandling(app);

  // Who is calling, before anything that depends on it.
  addAuthentication(app, { accessTokens: deps.accessTokens, guestSessions: deps.guestSessions });

  addRateLimiting(app, { store: deps.rateLimitStore });

  addIdempotency(app, {
    store: deps.idempotencyStore,
    subjectOf: (request) => subjectOf(request.principal),
  });

  void app.register(healthRoutes(deps), { prefix: '/health' });
  void app.register(webhookRoutes(deps), { prefix: '/webhooks' });
  void app.register(wellKnownRoutes(deps), { prefix: '/.well-known' });

  // Every route inside v1Routes gets "/v1" in front of its path.
  void app.register(v1Routes(deps), { prefix: '/v1' });

  return app;
}
