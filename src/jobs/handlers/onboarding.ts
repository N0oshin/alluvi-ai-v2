// onboarding.generate_plan: the worker side of POST /v1/onboarding/plan-generations.
//
// The route created a `queued` generation and enqueued this job with its id.
// The job:
//
//   1. marks the generation `running`;
//   2. reads the saved onboarding answers it points at;
//   3. calls the calculator (document 05), which is instant;
//   4. ticks the five steps one by one, saving progress after each, so the
//      app polling GET .../{id} sees screens 113 to 115 move;
//   5. saves the result and marks the generation `completed`.
//
// A known failure (an answer went missing, guard 6 of document 05) marks the
// generation `failed` with a code and ends the job normally. An unexpected
// error is thrown, so the queue retries the job; the retry starts again from
// step 1, which is safe because a finished generation is never touched.

import { setTimeout as sleep } from 'node:timers/promises';
import type { OnboardingResponse, OnboardingStore } from '../../db/onboarding-store.js';
import type { PlanGenerationStore } from '../../db/plan-generation-store.js';
import { planStepEnum } from '../../db/schema/index.js';
import {
  calculatePlan,
  ImplausiblePlanError,
  type PlanInputs,
  type PlanResult,
} from '../../modules/onboarding/plan-calculator.js';
import { toPlanResultBody } from '../../modules/onboarding/plan-result.js';
import { ageInYears, missingAnswers } from '../../modules/onboarding/rules.js';
import type { JobPayloads } from '../definitions.js';
import type { JobHandler } from '../queue.js';

// The pause after each step ticks (decision 52). The calculation itself takes
// milliseconds; the pause exists so a client polling once a second shows the
// five lines filling in, as the design does, instead of jumping from 0 to
// 100. Five steps at this value take about 3.5 seconds in all. Set to 0 to
// finish at once, in which case the client has to animate the ticks itself.
export const PLAN_STEP_DELAY_MS = 700;

export interface GeneratePlanDependencies {
  onboarding: OnboardingStore;
  planGenerations: PlanGenerationStore;
  // Tests set these; production uses the defaults.
  stepDelayMs?: number;
  now?: () => Date;
  calculate?: (inputs: PlanInputs) => PlanResult;
}

// The stored answers as calculator inputs, or null if one is missing. The
// age is worked out here, from the generation date, so the calculator itself
// stays free of any clock.
function toPlanInputs(answers: OnboardingResponse, on: Date): PlanInputs | null {
  const { sex, workoutFrequency, birthDate, heightCm, weightKg, targetWeightKg, goal } = answers;
  if (
    sex === null ||
    workoutFrequency === null ||
    birthDate === null ||
    heightCm === null ||
    weightKg === null ||
    targetWeightKg === null ||
    goal === null
  ) {
    return null;
  }
  return {
    sex,
    workoutFrequency,
    ageYears: ageInYears(birthDate, on),
    heightCm,
    weightKg,
    targetWeightKg,
    goal,
  };
}

export function generatePlan(
  deps: GeneratePlanDependencies,
): JobHandler<JobPayloads['onboarding.generate_plan']> {
  const now = deps.now ?? (() => new Date());
  const calculate = deps.calculate ?? calculatePlan;
  const stepDelayMs = deps.stepDelayMs ?? PLAN_STEP_DELAY_MS;
  const steps = planStepEnum.enumValues;

  return async (payload, context) => {
    const id = payload.planGenerationId;

    // 1. queued or running -> running. Null means the generation is gone or
    // already finished: nothing to do, and not an error (a duplicate or late
    // delivery of the job lands here).
    const generation = await deps.planGenerations.start(id, now());
    if (generation === null) {
      context.log.warn({ planGenerationId: id }, 'plan generation missing or already finished');
      return;
    }

    // 2. The answers the generation was started from.
    const answers = await deps.onboarding.findById(generation.onboardingResponseId);
    const inputs =
      answers !== null && missingAnswers(answers).length === 0
        ? toPlanInputs(answers, now())
        : null;
    if (inputs === null) {
      await deps.planGenerations.fail(id, 'onboarding_incomplete', now());
      context.log.warn({ planGenerationId: id }, 'plan generation failed: answers incomplete');
      return;
    }

    // 3. The calculation. Guard 6 of document 05 is the one expected failure.
    let plan: PlanResult;
    try {
      plan = calculate(inputs);
    } catch (error) {
      if (error instanceof ImplausiblePlanError) {
        await deps.planGenerations.fail(id, error.code, now());
        context.log.warn(
          { planGenerationId: id, caloriesKcal: error.caloriesKcal },
          'plan generation failed: implausible result',
        );
        return;
      }
      throw error;
    }

    // 4 and 5. Tick the steps in order. The last tick is the completion
    // itself, so the result and the 100% arrive in one update.
    for (let index = 0; index < steps.length; index += 1) {
      if (stepDelayMs > 0) {
        // Rejects if the worker is shutting down; the job is then retried.
        await sleep(stepDelayMs, undefined, { signal: context.signal });
      }

      const ticked = steps.slice(0, index + 1);
      if (ticked.length === steps.length) {
        await deps.planGenerations.complete(
          id,
          { result: toPlanResultBody(plan), algorithmVersion: plan.algorithmVersion },
          now(),
        );
      } else {
        const progressPct = Math.round((ticked.length / steps.length) * 100);
        await deps.planGenerations.recordSteps(id, ticked, progressPct, now());
      }
    }

    context.log.info(
      { planGenerationId: id, caloriesKcal: plan.caloriesKcal, warnings: plan.warnings },
      'plan generation completed',
    );
  };
}
