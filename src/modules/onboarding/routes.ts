// The onboarding module's HTTP routes.
//
//   PUT  /v1/onboarding/responses               save questionnaire answers, one screen at a time
//   POST /v1/onboarding/plan-generations        start a plan build; the worker does the work
//   GET  /v1/onboarding/plan-generations/{id}   the poll screens 113 to 116 read

import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { JobPayloads } from '../../jobs/definitions.js';
import type { JobQueue } from '../../jobs/queue.js';
import { AppError } from '../../shared/http/errors.js';
import { validate } from '../../shared/http/validate.js';
import {
  createPlanGeneration,
  findActivePlanGeneration,
  findOnboardingResponse,
  findPlanGenerationById,
  type OnboardingAnswers,
  type OnboardingOwner,
  type OnboardingResponse,
  type PlanGeneration,
  saveOnboardingResponse,
} from './queries.js';
import {
  birthDateProblem,
  missingAnswers,
  REQUIRED_ANSWERS,
  roundTo,
  TARGET_WEIGHT_MESSAGES,
  targetWeightMatchesGoal,
  toSnakeCase,
} from './rules.js';
import {
  acquisitionSourceEnum,
  motivationEnum,
  obstacleEnum,
  planStepEnum,
  sexEnum,
  unitSystemEnum,
  weightGoalDirectionEnum,
  workoutFrequencyEnum,
} from '../../shared/schema.js';

// Who the onboarding data belongs to: a guest while the person is answering,
// or a signed-in user. The auth hook has already refused anonymous callers
// on these routes; the throw is a safety net.
function ownerOf(request: FastifyRequest): OnboardingOwner {
  const principal = request.principal;
  switch (principal.kind) {
    case 'user':
      return { userId: principal.userId };
    case 'guest':
      return { guestSessionId: principal.guestSessionId };
    case 'anonymous':
      throw new AppError('unauthenticated');
  }
}

// The bounds are the database's CHECK constraints (document 01 section 4.2),
// repeated here so a bad value is a 422 naming the field, not a 500.
const answersSchema = z.strictObject({
  sex: z.enum(sexEnum.enumValues).optional(),
  workout_frequency: z.enum(workoutFrequencyEnum.enumValues).optional(),
  birth_date: z.iso.date().optional(),
  acquisition_source: z.enum(acquisitionSourceEnum.enumValues).optional(),
  tried_other_apps: z.boolean().optional(),
  unit_system: z.enum(unitSystemEnum.enumValues).optional(),
  height_cm: z.number().min(90).max(250).optional(),
  weight_kg: z.number().min(20).max(400).optional(),
  works_with_professional: z.boolean().optional(),
  goal: z.enum(weightGoalDirectionEnum.enumValues).optional(),
  target_weight_kg: z.number().min(20).max(400).optional(),
  obstacle: z.enum(obstacleEnum.enumValues).optional(),
  motivation: z.enum(motivationEnum.enumValues).optional(),
  sync_workouts: z.boolean().optional(),
  add_burned_calories: z.boolean().optional(),
  rollover_calories: z.boolean().optional(),
});

const paramsSchema = z.strictObject({ id: z.uuid() });

// The stored row in the API.
function toResponseBody(response: OnboardingResponse) {
  return {
    sex: response.sex,
    workout_frequency: response.workoutFrequency,
    birth_date: response.birthDate,
    acquisition_source: response.acquisitionSource,
    tried_other_apps: response.triedOtherApps,
    unit_system: response.unitSystem,
    height_cm: response.heightCm,
    weight_kg: response.weightKg,
    works_with_professional: response.worksWithProfessional,
    goal: response.goal,
    target_weight_kg: response.targetWeightKg,
    obstacle: response.obstacle,
    motivation: response.motivation,
    sync_workouts: response.syncWorkouts,
    add_burned_calories: response.addBurnedCalories,
    rollover_calories: response.rolloverCalories,
    completed_at: response.completedAt?.toISOString() ?? null,
    // The required answers still empty, in screen order, named as the API
    // names them. Empty means ready for a plan.
    missing_fields: missingAnswers(response).map(toSnakeCase),
  };
}

// A generation in the API's shape: the five lines of screens 113 to 115,
// each with whether it has ticked yet, in the order they tick.
function toPlanGenerationBody(generation: PlanGeneration) {
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

export function onboardingRoutes(jobs: JobQueue<JobPayloads>): FastifyPluginCallback {
  return (app, _options, done) => {
    // PUT is idempotent by nature (the same body twice leaves the same row),
    // so the route does not ask for an Idempotency-Key.
    app.put('/onboarding/responses', { config: { auth: 'user_or_guest' } }, async (request) => {
      const body = validate(answersSchema, request.body);
      const now = new Date();
      const owner = ownerOf(request);

      if (body.birth_date !== undefined) {
        const problem = birthDateProblem(body.birth_date, now.toISOString().slice(0, 10));
        if (problem !== null) {
          throw new AppError('validation_failed', [
            {
              field: 'birth_date',
              code: 'out_of_range',
              message:
                problem === 'in_future'
                  ? 'Birth date cannot be in the future.'
                  : 'Enter a birth date from 1900 onwards.',
            },
          ]);
        }
      }

      // Weights and height are rounded to what the columns keep before they
      // are compared or stored, so the consistency rule sees the stored values.
      const answers: OnboardingAnswers = {
        sex: body.sex,
        workoutFrequency: body.workout_frequency,
        birthDate: body.birth_date,
        acquisitionSource: body.acquisition_source,
        triedOtherApps: body.tried_other_apps,
        unitSystem: body.unit_system,
        heightCm: body.height_cm === undefined ? undefined : roundTo(body.height_cm, 2),
        weightKg: body.weight_kg === undefined ? undefined : roundTo(body.weight_kg, 1),
        worksWithProfessional: body.works_with_professional,
        goal: body.goal,
        targetWeightKg:
          body.target_weight_kg === undefined ? undefined : roundTo(body.target_weight_kg, 1),
        obstacle: body.obstacle,
        motivation: body.motivation,
        syncWorkouts: body.sync_workouts,
        addBurnedCalories: body.add_burned_calories,
        rolloverCalories: body.rollover_calories,
      };

      // Answers arrive one screen at a time, so both rules below are judged
      // on the required answers as they will be after this request.
      const stored = await findOnboardingResponse(owner);
      const after = {
        sex: answers.sex ?? stored?.sex ?? null,
        workoutFrequency: answers.workoutFrequency ?? stored?.workoutFrequency ?? null,
        birthDate: answers.birthDate ?? stored?.birthDate ?? null,
        unitSystem: answers.unitSystem ?? stored?.unitSystem ?? null,
        heightCm: answers.heightCm ?? stored?.heightCm ?? null,
        weightKg: answers.weightKg ?? stored?.weightKg ?? null,
        targetWeightKg: answers.targetWeightKg ?? stored?.targetWeightKg ?? null,
        goal: answers.goal ?? stored?.goal ?? null,
      };

      // Goal against weights. Runs only when this request touches one of the
      // three, so an unrelated screen is never blocked by an older
      // inconsistency.
      const touchesTarget =
        answers.goal !== undefined ||
        answers.weightKg !== undefined ||
        answers.targetWeightKg !== undefined;
      if (
        touchesTarget &&
        after.goal !== null &&
        after.weightKg !== null &&
        after.targetWeightKg !== null &&
        !targetWeightMatchesGoal(after.goal, after.weightKg, after.targetWeightKg)
      ) {
        throw new AppError('target_weight_inconsistent', [
          {
            field: 'target_weight_kg',
            code: 'target_weight_inconsistent',
            message: TARGET_WEIGHT_MESSAGES[after.goal],
          },
        ]);
      }

      // Complete when no required answer is missing. The time is kept from
      // the first request that completed it; null if the required list ever
      // grows and an old row is no longer complete (decision 44).
      const completedAt = missingAnswers(after).length === 0 ? (stored?.completedAt ?? now) : null;

      return toResponseBody(await saveOnboardingResponse(owner, answers, now, completedAt));
    });

    app.post(
      '/onboarding/plan-generations',
      // Creates a resource, so the Idempotency-Key header is required.
      { config: { auth: 'user_or_guest', idempotent: true } },
      async (request, reply) => {
        const stored = await findOnboardingResponse(ownerOf(request));

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

        // One build at a time per set of answers: a second tap while the
        // first is running gets the same generation back, not a second job.
        const running = await findActivePlanGeneration(stored.id);
        if (running !== null) {
          return reply.code(202).send(toPlanGenerationBody(running));
        }

        const generation = await createPlanGeneration(stored.id);
        await jobs.enqueue(
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
        // built from. Anyone else, and an id that does not exist, get the
        // same 404, so an id cannot be used to find out what exists.
        const [mine, generation] = await Promise.all([
          findOnboardingResponse(ownerOf(request)),
          findPlanGenerationById(id),
        ]);
        if (mine === null || generation === null || generation.onboardingResponseId !== mine.id) {
          throw new AppError('not_found');
        }

        // The status changes every second while it is polled; a cached copy
        // would show 24% for ever.
        void reply.header('Cache-Control', 'no-store');
        return {
          ...toPlanGenerationBody(generation),
          // Both keys always present (null when not applicable) so the client
          // reads one shape.
          result: generation.status === 'completed' ? generation.result : null,
          failure_code: generation.status === 'failed' ? generation.failureCode : null,
        };
      },
    );

    done();
  };
}
