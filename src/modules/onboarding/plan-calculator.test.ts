// Tests for the plan calculator, from document 05 sections 4 and 6. One row per
// case, spelled out, so a reader can see every boundary without following a loop.

import { describe, expect, it } from 'vitest';
import {
  ALGORITHM_VERSION,
  bmi,
  calculatePlan,
  computeMacros,
  ImplausiblePlanError,
  limitWeeklyLossRate,
  type PlanInputs,
} from './plan-calculator.js';

// A 30 year old woman, 70 kg, 170 cm, losing weight: a plain case to start from.
const base: PlanInputs = {
  sex: 'female',
  ageYears: 30,
  heightCm: 170,
  weightKg: 70,
  targetWeightKg: 65,
  goal: 'lose',
  workoutFrequency: '3_5',
};
const plan = (overrides: Partial<PlanInputs> = {}) => calculatePlan({ ...base, ...overrides });

describe('worked examples (document 05 section 4)', () => {
  it('A: the design sample, a woman losing weight', () => {
    const result = plan({
      sex: 'female',
      ageYears: 27,
      heightCm: 167.64,
      weightKg: 59.4,
      targetWeightKg: 54.4,
      goal: 'lose',
      workoutFrequency: '3_5',
    });
    expect(result).toMatchObject({
      caloriesKcal: 1760,
      proteinG: 95.0,
      fatG: 48.9,
      carbsG: 235.0,
      fiberG: 25,
      sugarG: 88.0,
      sodiumMg: 2300,
      waterMl: 2050,
      activityLevel: 'moderate',
      headline: { direction: 'lose', deltaKg: 5.0 },
      warnings: [],
      algorithmVersion: '2026.1',
    });
  });

  it('B: a large sedentary man, protein capped at 30% of calories', () => {
    const result = plan({
      sex: 'male',
      ageYears: 35,
      heightCm: 180,
      weightKg: 95,
      targetWeightKg: 85,
      goal: 'lose',
      workoutFrequency: '0_2',
    });
    expect(result).toMatchObject({
      caloriesKcal: 1760,
      proteinG: 132.0,
      fatG: 48.9,
      carbsG: 198.0,
      fiberG: 25,
      sugarG: 88.0,
      waterMl: 2850,
      activityLevel: 'sedentary',
      warnings: [],
    });
  });

  it('C: an underweight woman who chose lose is held at maintenance', () => {
    const result = plan({
      sex: 'female',
      ageYears: 22,
      heightCm: 160,
      weightKg: 42,
      targetWeightKg: 50,
      goal: 'lose',
      workoutFrequency: '3_5',
    });
    expect(result).toMatchObject({
      caloriesKcal: 1780,
      proteinG: 50.4,
      fatG: 49.4,
      carbsG: 283.4,
      fiberG: 25,
      sugarG: 89.0,
      waterMl: 1500,
      headline: { direction: 'maintain', deltaKg: 0 },
      warnings: ['underweight_no_deficit'],
    });
  });

  it('D: a man gaining weight, surplus clamped up to 200 kcal and fiber to 40 g', () => {
    const result = plan({
      sex: 'male',
      ageYears: 20,
      heightCm: 175,
      weightKg: 65,
      targetWeightKg: 70,
      goal: 'gain',
      workoutFrequency: '6_plus',
    });
    expect(result).toMatchObject({
      caloriesKcal: 3040,
      proteinG: 104.0,
      fatG: 84.4,
      carbsG: 466.0,
      fiberG: 40,
      sugarG: 152.0,
      waterMl: 2450,
      activityLevel: 'active',
      headline: { direction: 'gain', deltaKg: 5.0 },
      warnings: [],
    });
  });
});

describe('test table (document 05 section 6)', () => {
  it('sex other: BMR constant -78 and floor 1,350', () => {
    // 50 kg, 150 cm, age 60, sedentary, losing: 1,059.5 BMR, 1,271 TDEE,
    // 275 kcal deficit leaves 996, so the 1,350 floor applies.
    const result = plan({
      sex: 'other',
      ageYears: 60,
      heightCm: 150,
      weightKg: 50,
      targetWeightKg: 45,
      workoutFrequency: '0_2',
    });
    expect(result.caloriesKcal).toBe(1350);
    expect(result.warnings).toEqual(['calorie_floor_applied']);
  });

  it('age 17 years 364 days (17), lose: maintenance and warning 1', () => {
    const result = plan({ ageYears: 17 });
    expect(result.headline).toEqual({ direction: 'maintain', deltaKg: 0 });
    expect(result.warnings).toEqual(['age_under_18_maintenance_only']);
  });

  it('age 17 with a maintain goal still carries the warning', () => {
    const result = plan({ ageYears: 17, goal: 'maintain', targetWeightKg: 70 });
    expect(result.warnings).toEqual(['age_under_18_maintenance_only']);
  });

  it('age 18 exactly: normal plan', () => {
    const result = plan({ ageYears: 18 });
    expect(result.headline.direction).toBe('lose');
    expect(result.warnings).toEqual([]);
  });

  it('under 18 skips the adult BMI guards', () => {
    // 42 kg at 160 cm is BMI 16.4: guard 2 for an adult, but only guard 1 here.
    const result = plan({ ageYears: 16, weightKg: 42, heightCm: 160, targetWeightKg: 38 });
    expect(result.warnings).toEqual(['age_under_18_maintenance_only']);
  });

  it('BMI 18.475 (just under), lose: guard 2 fires', () => {
    // 200 cm: height squared is 4, so 73.9 kg is 18.475 and 74.0 kg is 18.5.
    expect(bmi(73.9, 200)).toBeCloseTo(18.475, 6);
    const result = plan({ heightCm: 200, weightKg: 73.9, targetWeightKg: 70 });
    expect(result.warnings).toContain('underweight_no_deficit');
    expect(result.headline.direction).toBe('maintain');
  });

  it('BMI 18.5 exactly, lose: guard 2 does not fire', () => {
    expect(bmi(74, 200)).toBe(18.5);
    const result = plan({ heightCm: 200, weightKg: 74, targetWeightKg: 70 });
    expect(result.warnings).not.toContain('underweight_no_deficit');
    expect(result.headline.direction).toBe('lose');
  });

  it('target under BMI 18.5 for a healthy person: plan produced, flagged (guard 3)', () => {
    // 170 cm: 53.5 kg is BMI 18.5, so a 50 kg target is 17.3.
    const result = plan({ weightKg: 70, targetWeightKg: 50 });
    expect(result.headline.direction).toBe('lose');
    expect(result.warnings).toEqual(['target_below_healthy_range']);
  });

  it('40 kg, 150 cm woman, age 60, sedentary, lose: guard 2 then the 1,200 floor', () => {
    const result = plan({
      ageYears: 60,
      heightCm: 150,
      weightKg: 40,
      targetWeightKg: 38,
      workoutFrequency: '0_2',
    });
    expect(result.caloriesKcal).toBe(1200);
    expect(result.warnings).toEqual(['underweight_no_deficit', 'calorie_floor_applied']);
  });

  it('50 kg, 150 cm woman, age 60, sedentary, lose: the floor applies on a real deficit', () => {
    const result = plan({
      ageYears: 60,
      heightCm: 150,
      weightKg: 50,
      targetWeightKg: 45,
      workoutFrequency: '0_2',
    });
    expect(result.caloriesKcal).toBe(1200);
    expect(result.headline.direction).toBe('lose');
    expect(result.warnings).toEqual(['calorie_floor_applied']);
  });

  it('150 kg, 175 cm man, lose: protein cap 30%, deficit clamp 750, fiber at most 40', () => {
    const result = plan({
      sex: 'male',
      ageYears: 35,
      heightCm: 175,
      weightKg: 150,
      targetWeightKg: 120,
      workoutFrequency: '0_2',
    });
    // TDEE 2,908.5, deficit 825 clamped to 750, so 2,158.5 rounds to 2,160.
    expect(result.caloriesKcal).toBe(2160);
    expect(result.proteinG).toBe(162.0); // 30% of 2,160 kcal / 4, not 1.6 x 150 = 240
    expect(result.fiberG).toBeLessThanOrEqual(40);
  });

  it('20 kg at 90 cm (database lower limits): no NaN, no negatives, water 1,500', () => {
    const result = plan({
      ageYears: 30,
      heightCm: 90,
      weightKg: 20,
      targetWeightKg: 19,
      workoutFrequency: '0_2',
    });
    expect(result.caloriesKcal).toBe(1200);
    expect(result.waterMl).toBe(1500);
    for (const value of [result.proteinG, result.carbsG, result.fatG, result.sugarG]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('400 kg at 250 cm (database upper limits): no NaN, no negatives, water 4,000', () => {
    const result = plan({
      sex: 'male',
      ageYears: 30,
      heightCm: 250,
      weightKg: 400,
      targetWeightKg: 300,
      workoutFrequency: '6_plus',
    });
    expect(result.caloriesKcal).toBe(8600);
    expect(result.waterMl).toBe(4000);
    for (const value of [result.proteinG, result.carbsG, result.fatG, result.sugarG]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('maintain with a different target gives the same calories as an equal target', () => {
    // The API refuses this input (decision 43); the calculator ignores the target.
    const different = plan({ goal: 'maintain', targetWeightKg: 60 });
    const equal = plan({ goal: 'maintain', targetWeightKg: 70 });
    expect(different.caloriesKcal).toBe(equal.caloriesKcal);
    expect(different.headline).toEqual({ direction: 'maintain', deltaKg: 0 });
  });

  it('same inputs and version give identical output', () => {
    expect(plan()).toEqual(plan());
    expect(plan().algorithmVersion).toBe(ALGORITHM_VERSION);
  });
});

describe('activity mapping (decision 45)', () => {
  it('0_2 is sedentary, 3_5 moderate and 6_plus active; light is never produced', () => {
    expect(plan({ workoutFrequency: '0_2' }).activityLevel).toBe('sedentary');
    expect(plan({ workoutFrequency: '3_5' }).activityLevel).toBe('moderate');
    expect(plan({ workoutFrequency: '6_plus' }).activityLevel).toBe('active');
  });

  it('a higher activity answer gives more calories and more water', () => {
    const low = plan({ workoutFrequency: '0_2' });
    const mid = plan({ workoutFrequency: '3_5' });
    const high = plan({ workoutFrequency: '6_plus' });
    expect(low.caloriesKcal).toBeLessThan(mid.caloriesKcal);
    expect(mid.caloriesKcal).toBeLessThan(high.caloriesKcal);
    expect(low.waterMl).toBeLessThan(high.waterMl);
  });
});

describe('guards that cannot fire in v1, tested directly', () => {
  it('guard 5 caps a weekly loss rate above 1% of body weight', () => {
    expect(limitWeeklyLossRate(0.02)).toEqual({ rate: 0.01, capped: true });
    expect(limitWeeklyLossRate(0.005)).toEqual({ rate: 0.005, capped: false });
  });

  it('the fixed 0.5% rate never raises the rate_capped warning', () => {
    expect(plan().warnings).not.toContain('rate_capped');
  });

  it('the carbohydrate floor lowers protein gram for gram, no lower than 1.2 g/kg', () => {
    // 800 kcal, 40 kg: protein would be 60 g (the 30% cap), carbs 90 g.
    const macros = computeMacros(800, 40, 'lose');
    expect(macros.proteinG).toBeCloseTo(50, 6);
    expect(macros.carbsG).toBeCloseTo(100, 6);
    expect(macros.lowCarb).toBe(false);
  });

  it('flags low_carb_result when protein cannot go lower', () => {
    // 600 kcal, 80 kg: the cap leaves 45 g protein, already under 1.2 g/kg.
    const macros = computeMacros(600, 80, 'lose');
    expect(macros.proteinG).toBeCloseTo(45, 6);
    expect(macros.carbsG).toBeCloseTo(67.5, 6);
    expect(macros.lowCarb).toBe(true);
  });

  it('with the calorie floor in place, carbohydrate is never under 135 g', () => {
    // 1,200 kcal x (100% - 30% protein cap - 25% fat) / 4 = 135 g.
    const macros = computeMacros(1200, 150, 'lose');
    expect(macros.carbsG).toBeGreaterThanOrEqual(135 - 1e-9);
  });
});

describe('guard 6 (sanity range)', () => {
  it('has an error type that carries the code the worker records', () => {
    const error = new ImplausiblePlanError(11000);
    expect(error.code).toBe('implausible_inputs');
    expect(error.caloriesKcal).toBe(11000);
    expect(error).toBeInstanceOf(Error);
  });
});
