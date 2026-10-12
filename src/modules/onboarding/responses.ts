// PUT /v1/onboarding/responses . Saves questionnaire
// answers for the caller, a guest or a signed-in user. Partial updates: each
// screen sends only its own answer(s) and the rest are left as they were.
//

import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  OnboardingOwner,
  OnboardingResponse,
  OnboardingStore,
} from '../../db/onboarding-store.js';
import {
  acquisitionSourceEnum,
  motivationEnum,
  obstacleEnum,
  sexEnum,
  unitSystemEnum,
  weightGoalDirectionEnum,
  workoutFrequencyEnum,
} from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { validate } from '../../http/validate.js';

export interface OnboardingRouteDependencies {
  onboarding: OnboardingStore;
  now?: () => Date;
}

const bodySchema = z.strictObject({
  sex: z.enum(sexEnum.enumValues).optional(),
  workout_frequency: z.enum(workoutFrequencyEnum.enumValues).optional(),
  birth_date: z.iso.date().optional(),
  acquisition_source: z.enum(acquisitionSourceEnum.enumValues).optional(),
  tried_other_apps: z.boolean().optional(),
  unit_system: z.enum(unitSystemEnum.enumValues).optional(),
  height_cm: z.number().optional(),
  weight_kg: z.number().optional(),
  works_with_professional: z.boolean().optional(),
  goal: z.enum(weightGoalDirectionEnum.enumValues).optional(),
  target_weight_kg: z.number().optional(),
  obstacle: z.enum(obstacleEnum.enumValues).optional(),
  motivation: z.enum(motivationEnum.enumValues).optional(),
  sync_workouts: z.boolean().optional(),
  add_burned_calories: z.boolean().optional(),
  rollover_calories: z.boolean().optional(),
});

// Who the answers belong to.
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

// The stored row in the API.
function toBody(response: OnboardingResponse) {
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
  };
}

export function onboardingResponseRoutes(deps: OnboardingRouteDependencies): FastifyPluginCallback {
  const now = deps.now ?? (() => new Date());

  return (app, _options, done) => {
    // PUT is idempotent by nature (the same body twice leaves the same row), so
    // the route does not ask for an Idempotency-Key.
    app.put('/onboarding/responses', { config: { auth: 'user_or_guest' } }, async (request) => {
      const body = validate(bodySchema, request.body);
      const saved = await deps.onboarding.save(
        ownerOf(request),
        {
          sex: body.sex,
          workoutFrequency: body.workout_frequency,
          birthDate: body.birth_date,
          acquisitionSource: body.acquisition_source,
          triedOtherApps: body.tried_other_apps,
          unitSystem: body.unit_system,
          heightCm: body.height_cm,
          weightKg: body.weight_kg,
          worksWithProfessional: body.works_with_professional,
          goal: body.goal,
          targetWeightKg: body.target_weight_kg,
          obstacle: body.obstacle,
          motivation: body.motivation,
          syncWorkouts: body.sync_workouts,
          addBurnedCalories: body.add_burned_calories,
          rolloverCalories: body.rollover_calories,
        },
        now(),
      );
      return toBody(saved);
    });

    done();
  };
}
