// onboarding.generate_plan: the worker side of POST /v1/onboarding/plan-generations.
//
// The route created a `queued` generation and enqueued this job with its id.
// The job marks it `running`, reads the answers, calls the calculator
// (document 05, instant), ticks the five steps one by one with a pause after
// each so the polling app sees screens 113 to 115 move, then saves the result
// and marks the generation `completed`.
//
// A known failure (an answer went missing, guard 6 of document 05) marks the
// generation `failed` with a code and ends the job normally. An unexpected
// error is thrown, so the queue retries the job; the retry starts again from
// the beginning, which is safe because a finished generation is never touched.

import { setTimeout as sleep } from 'node:timers/promises';
import type { JobPayloads } from '../../jobs/definitions.js';
import type { JobHandler, JobHandlers } from '../../jobs/queue.js';
import {
  calculatePlan,
  ImplausiblePlanError,
  type PlanInputs,
  type PlanResult,
} from './plan-calculator.js';
import {
  completePlanGeneration,
  failPlanGeneration,
  findOnboardingResponseById,
  type OnboardingResponse,
  recordPlanSteps,
  startPlanGeneration,
} from './queries.js';
import { ageInYears, missingAnswers, toPlanResultBody } from './rules.js';
import { planStepEnum } from '../../shared/schema.js';

// The pause after each step ticks (decision 52). Five steps at this value
// take about 3.5 seconds in all.
export const PLAN_STEP_DELAY_MS = 700;

export interface GeneratePlanOptions {
  // Tests set these; production uses the defaults.
  stepDelayMs?: number;
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
  options: GeneratePlanOptions = {},
): JobHandler<JobPayloads['onboarding.generate_plan']> {
  const calculate = options.calculate ?? calculatePlan;
  const stepDelayMs = options.stepDelayMs ?? PLAN_STEP_DELAY_MS;
  const steps = planStepEnum.enumValues;

  return async (payload, context) => {
    const id = payload.planGenerationId;

    // Null means the generation is gone or already finished: nothing to do,
    // and not an error (a duplicate or late delivery of the job lands here).
    const generation = await startPlanGeneration(id, new Date());
    if (generation === null) {
      context.log.warn({ planGenerationId: id }, 'plan generation missing or already finished');
      return;
    }

    const answers = await findOnboardingResponseById(generation.onboardingResponseId);
    const inputs =
      answers !== null && missingAnswers(answers).length === 0
        ? toPlanInputs(answers, new Date())
        : null;
    if (inputs === null) {
      await failPlanGeneration(id, 'onboarding_incomplete', new Date());
      context.log.warn({ planGenerationId: id }, 'plan generation failed: answers incomplete');
      return;
    }

    let plan: PlanResult;
    try {
      plan = calculate(inputs);
    } catch (error) {
      if (error instanceof ImplausiblePlanError) {
        await failPlanGeneration(id, error.code, new Date());
        context.log.warn(
          { planGenerationId: id, caloriesKcal: error.caloriesKcal },
          'plan generation failed: implausible result',
        );
        return;
      }
      throw error;
    }

    // Tick the steps in order. The last tick is the completion itself, so
    // the result and the 100% arrive in one update.
    for (let index = 0; index < steps.length; index += 1) {
      if (stepDelayMs > 0) {
        // Rejects if the worker is shutting down; the job is then retried.
        await sleep(stepDelayMs, undefined, { signal: context.signal });
      }

      const ticked = steps.slice(0, index + 1);
      if (ticked.length === steps.length) {
        await completePlanGeneration(
          id,
          { result: toPlanResultBody(plan), algorithmVersion: plan.algorithmVersion },
          new Date(),
        );
      } else {
        const progressPct = Math.round((ticked.length / steps.length) * 100);
        await recordPlanSteps(id, ticked, progressPct, new Date());
      }
    }

    context.log.info(
      { planGenerationId: id, caloriesKcal: plan.caloriesKcal, warnings: plan.warnings },
      'plan generation completed',
    );
  };
}

export const onboardingJobs: Pick<JobHandlers<JobPayloads>, 'onboarding.generate_plan'> = {
  'onboarding.generate_plan': generatePlan(),
};
