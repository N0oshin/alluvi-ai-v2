import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryOnboardingStore, type OnboardingAnswers } from '../../db/onboarding-store.js';
import {
  memoryPlanGenerationStore,
  type PlanGenerationStore,
  type PlanStep,
} from '../../db/plan-generation-store.js';
import { ImplausiblePlanError } from '../../modules/onboarding/plan-calculator.js';
import type { JobContext } from '../queue.js';
import { generatePlan, type GeneratePlanDependencies } from './onboarding.js';

const info = vi.fn();
const warn = vi.fn();
const context: JobContext = {
  id: 'job-1',
  attempt: 0,
  signal: new AbortController().signal,
  log: { info, warn, error: vi.fn() },
};

const at = new Date('2026-10-12T12:00:00Z');

// The design's sample person (document 05 example A): 27 on the test date.
const exampleA: OnboardingAnswers = {
  sex: 'female',
  workoutFrequency: '3_5',
  birthDate: '1999-03-14',
  unitSystem: 'metric',
  heightCm: 167.64,
  weightKg: 59.4,
  targetWeightKg: 54.4,
  goal: 'lose',
};

function setup(answers: OnboardingAnswers = exampleA) {
  const onboarding = memoryOnboardingStore();
  const planGenerations = memoryPlanGenerationStore();

  const start = async () => {
    const saved = await onboarding.save({ guestSessionId: 'guest-1' }, answers, at);
    return planGenerations.create(saved.id, at);
  };
  const run = (generationId: string, overrides: Partial<GeneratePlanDependencies> = {}) =>
    generatePlan({
      onboarding,
      planGenerations,
      stepDelayMs: 0,
      now: () => at,
      ...overrides,
    })({ planGenerationId: generationId }, context);

  return { onboarding, planGenerations, start, run };
}

describe('onboarding.generate_plan', () => {
  beforeEach(() => {
    info.mockClear();
    warn.mockClear();
  });

  it('completes a queued generation with the calculated plan', async () => {
    const { planGenerations, start, run } = setup();
    const generation = await start();

    await run(generation.id);

    const done = await planGenerations.findById(generation.id);
    expect(done).toMatchObject({
      status: 'completed',
      progressPct: 100,
      stepsCompleted: ['calories', 'carbs', 'protein', 'fats', 'health_score'],
      algorithmVersion: '2026.1',
      failureCode: null,
    });
    // Document 05 example A, in the API's shape.
    expect(done?.result).toMatchObject({
      headline: { direction: 'lose', delta_kg: 5 },
      calories_kcal: 1760,
      protein_g: 95,
      carbs_g: 235,
      fat_g: 48.9,
      fiber_g: 25,
      sugar_g: 88,
      sodium_mg: 2300,
      water_ml: 2050,
      current_weight_kg: 59.4,
      target_weight_kg: 54.4,
      activity_level: 'moderate',
      warnings: [],
      algorithm_version: '2026.1',
    });
    expect(info).toHaveBeenCalledWith(
      { planGenerationId: generation.id, caloriesKcal: 1760, warnings: [] },
      'plan generation completed',
    );
  });

  it('ticks the steps one at a time, in order, saving progress after each', async () => {
    const { planGenerations, start, run } = setup();
    const generation = await start();

    const saved: [PlanStep[], number][] = [];
    const recording: PlanGenerationStore = {
      ...planGenerations,
      recordSteps(id, steps, progressPct, now) {
        saved.push([[...steps], progressPct]);
        return planGenerations.recordSteps(id, steps, progressPct, now);
      },
    };
    await run(generation.id, { planGenerations: recording });

    expect(saved).toEqual([
      [['calories'], 20],
      [['calories', 'carbs'], 40],
      [['calories', 'carbs', 'protein'], 60],
      [['calories', 'carbs', 'protein', 'fats'], 80],
    ]);
  });

  it('works out the age on the day it runs and applies the under-18 rule', async () => {
    // Born 2010-05-01: 16 on the test date.
    const { planGenerations, start, run } = setup({ ...exampleA, birthDate: '2010-05-01' });
    const generation = await start();

    await run(generation.id);

    const done = await planGenerations.findById(generation.id);
    expect(done?.result).toMatchObject({
      headline: { direction: 'maintain', delta_kg: 0 },
      warnings: ['age_under_18_maintenance_only'],
    });
  });

  it('fails with implausible_inputs when the calculator refuses the result', async () => {
    const { planGenerations, start, run } = setup();
    const generation = await start();

    await run(generation.id, {
      calculate: () => {
        throw new ImplausiblePlanError(11000);
      },
    });

    expect(await planGenerations.findById(generation.id)).toMatchObject({
      status: 'failed',
      failureCode: 'implausible_inputs',
      result: null,
    });
    expect(warn).toHaveBeenCalled();
  });

  it('fails with onboarding_incomplete if a required answer is missing', async () => {
    const { goal: _goal, ...withoutGoal } = exampleA;
    const { planGenerations, start, run } = setup(withoutGoal);
    const generation = await start();

    await run(generation.id);

    expect(await planGenerations.findById(generation.id)).toMatchObject({
      status: 'failed',
      failureCode: 'onboarding_incomplete',
    });
  });

  it('throws an unexpected error so the job is retried, and the retry finishes the work', async () => {
    const { planGenerations, start, run } = setup();
    const generation = await start();

    await expect(
      run(generation.id, {
        calculate: () => {
          throw new Error('database connection lost');
        },
      }),
    ).rejects.toThrow('database connection lost');
    // Not failed: the retry may still succeed.
    expect((await planGenerations.findById(generation.id))?.status).toBe('running');

    await run(generation.id);
    expect((await planGenerations.findById(generation.id))?.status).toBe('completed');
  });

  it('does nothing for a generation that already finished', async () => {
    const { planGenerations, start, run } = setup();
    const generation = await start();
    await run(generation.id);
    const before = await planGenerations.findById(generation.id);

    const calculate = vi.fn();
    await run(generation.id, { calculate });

    expect(calculate).not.toHaveBeenCalled();
    expect(await planGenerations.findById(generation.id)).toEqual(before);
    expect(warn).toHaveBeenCalledWith(
      { planGenerationId: generation.id },
      'plan generation missing or already finished',
    );
  });

  it('does nothing, and does not throw, for a generation that does not exist', async () => {
    const { run } = setup();
    await expect(run('019a0000-0000-7000-8000-00000000dead')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('stops with an error when the worker is shutting down, leaving the generation running', async () => {
    const { onboarding, planGenerations, start } = setup();
    const generation = await start();
    const controller = new AbortController();
    controller.abort();

    const handler = generatePlan({ onboarding, planGenerations, stepDelayMs: 50, now: () => at });
    await expect(
      handler({ planGenerationId: generation.id }, { ...context, signal: controller.signal }),
    ).rejects.toThrow();

    // Running, not failed: the queue retries the job and it starts again.
    expect((await planGenerations.findById(generation.id))?.status).toBe('running');
  });
});
