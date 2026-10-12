// POST /v1/onboarding/plan-generations (document 02 section 3.4) starts a plan
// build and answers at once with a generation the app polls. The calculation
// itself runs in the worker.
//
// GET /v1/onboarding/plan-generations/{id} (section 3.5) is that poll: screens
// 113 to 115 read it about once a second, and screen 116 reads the result.

import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { OnboardingStore } from '../../db/onboarding-store.js';
import type { PlanGeneration, PlanGenerationStore } from '../../db/plan-generation-store.js';
import { planStepEnum } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { validate } from '../../http/validate.js';
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

// What the poll returns: the same body as the POST, plus the plan once it is
// completed and the failure code once it has failed. Both keys are always
// present (null when not applicable) so the client reads one shape.
export function toPlanGenerationDetailBody(generation: PlanGeneration) {
  return {
    ...toPlanGenerationBody(generation),
    result: generation.status === 'completed' ? generation.result : null,
    failure_code: generation.status === 'failed' ? generation.failureCode : null,
  };
}

const paramsSchema = z.strictObject({ id: z.uuid() });

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

    app.get(
      '/onboarding/plan-generations/:id',
      { config: { auth: 'user_or_guest' } },
      async (request, reply) => {
        const { id } = validate(paramsSchema, request.params);

        // A generation is readable only by whoever owns the answers it was
        // built from. Anyone else, and an id that does not exist, get the same
        // 404, so an id cannot be used to find out what exists.
        const [mine, generation] = await Promise.all([
          deps.onboarding.find(ownerOf(request)),
          deps.planGenerations.findById(id),
        ]);
        if (mine === null || generation === null || generation.onboardingResponseId !== mine.id) {
          throw new AppError('not_found');
        }

        // The status changes every second while it is polled; a cached copy
        // would show 24% for ever.
        reply.header('Cache-Control', 'no-store');
        return toPlanGenerationDetailBody(generation);
      },
    );

    done();
  };
}
