// POST /v1/onboarding/plan-generations. Starts the
// plan and answers at once with a generation
// the app polls. The calculation itself runs in the worker.

import type { FastifyPluginCallback } from 'fastify';
import type { OnboardingStore } from '../../db/onboarding-store.js';
import type { PlanGeneration, PlanGenerationStore } from '../../db/plan-generation-store.js';
import { planStepEnum } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { JobPayloads } from '../../jobs/definitions.js';
import type { JobQueue } from '../../jobs/queue.js';
import { ownerOf } from './owner.js';
import { missingAnswers, REQUIRED_ANSWERS, toSnakeCase } from './rules.js';

export interface PlanGenerationRouteDependencies {
  onboarding: OnboardingStore;
  planGenerations: PlanGenerationStore;
  jobs: JobQueue<JobPayloads>;
  now?: () => Date;
}

// A generation in the API's shape: the five lines of screens 113 to 115, each
// with whether it has ticked yet, in the order they tick.
export function toPlanGenerationBody(generation: PlanGeneration) {
  return {
    id: generation.id,
    status: generation.status,
    progress_pct: generation.progressPct,
    steps: planStepEnum.enumValues.map((key) => ({
      key,
      done: generation.stepsCompleted.includes(key),
    })),
  };
}

export function planGenerationRoutes(deps: PlanGenerationRouteDependencies): FastifyPluginCallback {
  const now = deps.now ?? (() => new Date());

  return (app, _options, done) => {
    app.post(
      '/onboarding/plan-generations',
      // Creates a resource, so the Idempotency-Key header is required
      // (document 02 section 1).
      { config: { auth: 'user_or_guest', idempotent: true } },
      async (request, reply) => {
        const stored = await deps.onboarding.find(ownerOf(request));

        // The same list `missing_fields` reports. No row yet means none of
        // the answers exist.
        const missing = stored === null ? [...REQUIRED_ANSWERS] : missingAnswers(stored);
        if (stored === null || missing.length > 0) {
          throw new AppError(
            'onboarding_incomplete',
            missing.map((name) => ({
              field: toSnakeCase(name),
              code: 'required',
              message: 'This answer is needed to build your plan.',
            })),
          );
        }

        // One build at a time per set of answers: a second tap while the first
        // is running gets the same generation back, not a second job.
        const running = await deps.planGenerations.findActive(stored.id);
        if (running !== null) {
          return reply.code(202).send(toPlanGenerationBody(running));
        }

        const generation = await deps.planGenerations.create(stored.id, now());
        await deps.jobs.enqueue(
          'onboarding.generate_plan',
          { planGenerationId: generation.id },
          { singletonKey: generation.id },
        );
        return reply.code(202).send(toPlanGenerationBody(generation));
      },
    );

    done();
  };
}
