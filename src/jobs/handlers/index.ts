// The worker polls the database for jobs, and when it finds one it calls the handler for that name. The handler is a function that receives the job's payload and a context with the job's id, the attempt number, a signal that fires when the worker is shutting down, and a logger. The handler runs outside any HTTP request, so it can take its time and do whatever it needs to do.

import type { GuestSessionStore } from '../../db/guest-session-store.js';
import type { MagicLinkStore } from '../../db/magic-link-store.js';
import type { OnboardingStore } from '../../db/onboarding-store.js';
import type { PlanGenerationStore } from '../../db/plan-generation-store.js';
import type { OutboxStore } from '../../db/outbox.js';
import type { IdempotencyStore } from '../../http/idempotency.js';
import type { RateLimitStore } from '../../http/rate-limit.js';
import type { Providers } from '../../providers/index.js';
import type { JobPayloads } from '../definitions.js';
import type { JobHandlers } from '../queue.js';
import { identityPurge } from './identity.js';
import { infrastructureCleanup } from './infrastructure.js';
import { generatePlan } from './onboarding.js';
import { outboxPublish, type OutboxConsumers } from './outbox.js';

export interface HandlerDependencies {
  idempotencyStore: IdempotencyStore;
  rateLimitStore: RateLimitStore;
  outboxStore: OutboxStore;
  magicLinkStore: MagicLinkStore;
  guestSessionStore: GuestSessionStore;
  // The plan build reads answers and writes progress (Phase 3.3).
  onboardingStore: OnboardingStore;
  planGenerationStore: PlanGenerationStore;
  // Event type -> consumers, assembled in the worker as phases add them.
  consumers: OutboxConsumers;
  // Jobs that call a vendor (scan analysis, email, push) take it from here.
  providers: Providers;
}

export function buildHandlers(deps: HandlerDependencies): JobHandlers<JobPayloads> {
  return {
    'infrastructure.cleanup': infrastructureCleanup(deps),
    'identity.purge': identityPurge(deps),
    'onboarding.generate_plan': generatePlan({
      onboarding: deps.onboardingStore,
      planGenerations: deps.planGenerationStore,
    }),
    'outbox.publish': outboxPublish({ outbox: deps.outboxStore, consumers: deps.consumers }),
  };
}
