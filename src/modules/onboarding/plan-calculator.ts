// The plan calculator
//
// A pure function. The same inputs always give the same output; it reads no
// database and no clock (the caller works out the age).

import type {
  activityLevelEnum,
  EnumValue,
  sexEnum,
  weightGoalDirectionEnum,
  workoutFrequencyEnum,
} from '../../db/schema/index.js';

type Sex = EnumValue<typeof sexEnum>;
type Goal = EnumValue<typeof weightGoalDirectionEnum>;
type WorkoutFrequency = EnumValue<typeof workoutFrequencyEnum>;
type ActivityLevel = EnumValue<typeof activityLevelEnum>;

export const ALGORITHM_VERSION = '2026.1';

export interface PlanInputs {
  sex: Sex;
  // Whole completed years at the calculation date, worked out by the caller.
  ageYears: number;
  heightCm: number;
  weightKg: number;
  targetWeightKg: number;
  goal: Goal;
  workoutFrequency: WorkoutFrequency;
}

export type PlanWarning =
  | 'age_under_18_maintenance_only'
  | 'underweight_no_deficit'
  | 'target_below_healthy_range'
  | 'calorie_floor_applied'
  | 'rate_capped'
  | 'low_carb_result';

export interface PlanResult {
  headline: { direction: Goal; deltaKg: number };
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  sugarG: number;
  sodiumMg: number;
  waterMl: number;
  currentWeightKg: number;
  targetWeightKg: number;
  activityLevel: ActivityLevel;
  warnings: PlanWarning[];
  algorithmVersion: string;
}

// Guard 6: the result is outside what the database allows. The worker turns it into `failure_code: implausible_inputs`.
export class ImplausiblePlanError extends Error {
  readonly code = 'implausible_inputs';
  readonly caloriesKcal: number;

  constructor(caloriesKcal: number) {
    super(`Calculated ${caloriesKcal} kcal is outside the allowed range`);
    this.name = 'ImplausiblePlanError';
    this.caloriesKcal = caloriesKcal;
  }
}

// ---- The numbers --------------------------------

// Step 1: Mifflin-St Jeor. `other` is the midpoint of the two published constants.
const BMR_SEX_CONSTANT: Record<Sex, number> = { male: 5, female: -161, other: -78 };

// Step 2 and step 6: activity. `light` is never produced here.
const ACTIVITY: Record<
  WorkoutFrequency,
  { level: ActivityLevel; multiplier: number; waterExtraMl: number }
> = {
  '0_2': { level: 'sedentary', multiplier: 1.2, waterExtraMl: 0 },
  '3_5': { level: 'moderate', multiplier: 1.55, waterExtraMl: 250 },
  '6_plus': { level: 'active', multiplier: 1.725, waterExtraMl: 500 },
};

// Step 3: a fixed share of body weight per week, turned into a
// daily budget with 7,700 kcal per kg. A budget, not a prediction.
const KCAL_PER_KG = 7700;
const WEEKLY_RATE = { lose: 0.005, gain: 0.0025 };
const DAILY_CHANGE_CLAMP = { lose: [250, 750], gain: [200, 500] } as const;

// Guard 5: a deficit is never more than 1% of body weight a week.
const MAX_WEEKLY_LOSS_RATE = 0.01;

// Guard 2 and 3.
const UNDERWEIGHT_BMI = 18.5;
const ADULT_AGE = 18;

// Guard 4.
const CALORIE_FLOOR: Record<Sex, number> = { male: 1500, female: 1200, other: 1350 };

// Guard 6.
const PLAUSIBLE_CALORIES = { min: 800, max: 10000 };

// Step 4.
const PROTEIN_G_PER_KG: Record<Goal, number> = { lose: 1.6, maintain: 1.2, gain: 1.6 };
const PROTEIN_MIN_G_PER_KG = 0.8;
const PROTEIN_MAX_SHARE = 0.3;
const FAT_SHARE = 0.25;
const MIN_CARBS_G = 100;

// Step 5.
const FIBER_G_PER_1000_KCAL = 14;
const FIBER_CLAMP_G = [20, 40] as const;
const SODIUM_MG = 2300;
const SUGAR_SHARE = 0.2;

// Step 6.
const WATER_ML_PER_KG = 30;
const WATER_CLAMP_ML = [1500, 4000] as const;

// ---- Small helpers --------------------------------------------------------------

// Rounds half up at the given number of decimals. The 1e-9 keeps a value that
// is exactly half in decimal (283.35) from falling the wrong way because the
// binary double is 283.34999999999997.
function roundHalfUp(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + 1e-9) * factor) / factor;
}

const roundToNearest = (value: number, step: number): number => Math.round(value / step) * step;
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function bmi(weightKg: number, heightCm: number): number {
  const heightM = heightCm / 100;
  return weightKg / (heightM * heightM);
}

// Guard 5 on its own, so it can be tested: the fixed 0.5% rate never reaches
// the cap, and a future pace question must not be able to bypass it.
export function limitWeeklyLossRate(rate: number): { rate: number; capped: boolean } {
  return rate > MAX_WEEKLY_LOSS_RATE
    ? { rate: MAX_WEEKLY_LOSS_RATE, capped: true }
    : { rate, capped: false };
}

// Step 4 on its own, for the same reason: with the calorie floor in place the
// carbohydrate result is never under 135 g, so the low-carb branch is a
// safety net that only a direct call can reach.
export function computeMacros(caloriesKcal: number, weightKg: number, goal: Goal) {
  const minProteinG = PROTEIN_MIN_G_PER_KG * weightKg;
  const maxProteinG = (PROTEIN_MAX_SHARE * caloriesKcal) / 4;
  // The 30% cap wins over the 0.8 g/kg floor if they ever disagree (decision 50).
  let proteinG = Math.min(maxProteinG, Math.max(minProteinG, PROTEIN_G_PER_KG[goal] * weightKg));
  const fatG = (FAT_SHARE * caloriesKcal) / 9;
  let carbsG = (caloriesKcal - 4 * proteinG - 9 * fatG) / 4;

  if (carbsG < MIN_CARBS_G) {
    // Give protein up gram for gram (4 kcal each), but never below 1.2 g/kg
    // and never raise it.
    const lowest = Math.min(proteinG, 1.2 * weightKg);
    proteinG = Math.max(lowest, proteinG - (MIN_CARBS_G - carbsG));
    carbsG = (caloriesKcal - 4 * proteinG - 9 * fatG) / 4;
  }

  return { proteinG, fatG, carbsG, lowCarb: carbsG < MIN_CARBS_G };
}

// ---- The calculator -------------------------------------------------------------

export function calculatePlan(inputs: PlanInputs): PlanResult {
  const { sex, ageYears, heightCm, weightKg, targetWeightKg, workoutFrequency } = inputs;
  const warnings: PlanWarning[] = [];

  // Step 1 and 2.
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * ageYears + BMR_SEX_CONSTANT[sex];
  const activity = ACTIVITY[workoutFrequency];
  const tdee = bmr * activity.multiplier;

  // Guards 1 to 3 decide which direction the plan really follows. Adult BMI
  // bands do not apply to growing bodies, so under 18 skips guards 2 and 3.
  let direction: Goal = inputs.goal;
  if (ageYears < ADULT_AGE) {
    // Raised for every under-18 plan, whatever goal was chosen, so the record
    // shows which rules produced it (decision 50).
    warnings.push('age_under_18_maintenance_only');
    direction = 'maintain';
  } else if (direction === 'lose') {
    if (bmi(weightKg, heightCm) < UNDERWEIGHT_BMI) {
      warnings.push('underweight_no_deficit');
      direction = 'maintain';
    } else if (bmi(targetWeightKg, heightCm) < UNDERWEIGHT_BMI) {
      warnings.push('target_below_healthy_range');
    }
  }

  // Step 3, with guard 5 on the rate. Its warning is added after guard 4's so
  // that warnings come out in guard-number order (decision 50).
  let dailyChange = 0;
  let rateCapped = false;
  if (direction === 'lose' || direction === 'gain') {
    let rate = WEEKLY_RATE[direction];
    if (direction === 'lose') {
      const limited = limitWeeklyLossRate(rate);
      rate = limited.rate;
      rateCapped = limited.capped;
    }
    const [low, high] = DAILY_CHANGE_CLAMP[direction];
    const magnitude = clamp((rate * weightKg * KCAL_PER_KG) / 7, low, high);
    dailyChange = direction === 'lose' ? -magnitude : magnitude;
  }

  // Calories to the nearest 10, then guard 4.
  let caloriesKcal = roundToNearest(tdee + dailyChange, 10);
  const floor = CALORIE_FLOOR[sex];
  if (caloriesKcal < floor) {
    caloriesKcal = floor;
    warnings.push('calorie_floor_applied');
  }
  if (rateCapped) warnings.push('rate_capped');

  // Guard 6.
  if (caloriesKcal < PLAUSIBLE_CALORIES.min || caloriesKcal > PLAUSIBLE_CALORIES.max) {
    throw new ImplausiblePlanError(caloriesKcal);
  }

  // Step 4.
  const macros = computeMacros(caloriesKcal, weightKg, direction);
  if (macros.lowCarb) warnings.push('low_carb_result');

  // Step 5 and 6.
  const fiberG = clamp(
    Math.round((FIBER_G_PER_1000_KCAL * caloriesKcal) / 1000),
    FIBER_CLAMP_G[0],
    FIBER_CLAMP_G[1],
  );
  const waterMl = clamp(
    roundToNearest(WATER_ML_PER_KG * weightKg + activity.waterExtraMl, 50),
    WATER_CLAMP_ML[0],
    WATER_CLAMP_ML[1],
  );

  return {
    headline: {
      direction,
      deltaKg: direction === 'maintain' ? 0 : roundHalfUp(Math.abs(targetWeightKg - weightKg), 1),
    },
    caloriesKcal,
    proteinG: roundHalfUp(macros.proteinG, 1),
    carbsG: roundHalfUp(macros.carbsG, 1),
    fatG: roundHalfUp(macros.fatG, 1),
    fiberG,
    sugarG: roundHalfUp((SUGAR_SHARE * caloriesKcal) / 4, 1),
    sodiumMg: SODIUM_MG,
    waterMl,
    currentWeightKg: weightKg,
    targetWeightKg,
    activityLevel: activity.level,
    warnings,
    algorithmVersion: ALGORITHM_VERSION,
  };
}
