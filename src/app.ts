// Builds the application without starting a network listener.

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { JobPayloads } from './jobs/definitions.js';
import type { JobQueue } from './jobs/queue.js';
import { webhookRoutes } from './modules/email/index.js';
import {
  identityRoutes,
  magicLinkPageRoutes,
  resolveGuestSession,
} from './modules/identity/index.js';
import { onboardingRoutes } from './modules/onboarding/index.js';
import type { Providers } from './providers/index.js';
import { accessTokens } from './shared/auth/access-token.js';
import { addAuthentication, type Principal } from './shared/http/auth.js';
import { addErrorHandling } from './shared/http/error-handler.js';
import { healthRoutes, type HealthDependencies } from './shared/http/health.js';
import { addIdempotency, type IdempotencyStore } from './shared/http/idempotency.js';
import { RequestLogController } from './shared/http/logging.js';
import { addRateLimiting, type RateLimitStore } from './shared/http/rate-limit.js';
import { addRequestIdHeader, generateRequestId } from './shared/http/request-id.js';
import { wellKnownRoutes, type AppLinkConfig } from './shared/http/well-known.js';

// What differs between a real run and a test: the external services, the job
// queue, and the two middleware stores. Modules import everything else.
export type AppDependencies = HealthDependencies & {
  idempotencyStore: IdempotencyStore;
  rateLimitStore: RateLimitStore;
  // Background jobs the routes enqueue. Handlers run in the worker process.
  jobs: JobQueue<JobPayloads>;
  providers: Providers;
  // Universal Link / App Link files, for group invite links.
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
  addAuthentication(app, { accessTokens, resolveGuest: resolveGuestSession });
  addRateLimiting(app, { store: deps.rateLimitStore });
  addIdempotency(app, {
    store: deps.idempotencyStore,
    subjectOf: (request) => subjectOf(request.principal),
  });

  // Outside /v1: operations, other services, and the browser.
  void app.register(healthRoutes(deps), { prefix: '/health' });
  void app.register(webhookRoutes(), { prefix: '/webhooks' });
  void app.register(wellKnownRoutes(deps), { prefix: '/.well-known' });
  void app.register(magicLinkPageRoutes());

  // Every module's routes, under /v1.
  void app.register(
    (v1, _options, done) => {
      v1.get('/ping', () => ({ pong: true }));
      void v1.register(identityRoutes(deps.providers));
      void v1.register(onboardingRoutes(deps.jobs));
      done();
    },
    { prefix: '/v1' },
  );

  return app;
}
