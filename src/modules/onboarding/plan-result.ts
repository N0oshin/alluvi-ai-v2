// The plan as stored in `plan_generations.result` and returned by
// GET /v1/onboarding/plan-generations/{id} (document 02 section 3.5): the
// calculator's camelCase result in the API's snake_case shape.
//
// Written once here so the worker (which stores it) and the GET route (which
// returns it) cannot disagree about the field names.

import type { PlanResult } from './plan-calculator.js';

export function toPlanResultBody(plan: PlanResult) {
  return {
    headline: { direction: plan.headline.direction, delta_kg: plan.headline.deltaKg },
    calories_kcal: plan.caloriesKcal,
    protein_g: plan.proteinG,
    carbs_g: plan.carbsG,
    fat_g: plan.fatG,
    fiber_g: plan.fiberG,
    sugar_g: plan.sugarG,
    sodium_mg: plan.sodiumMg,
    water_ml: plan.waterMl,
    current_weight_kg: plan.currentWeightKg,
    target_weight_kg: plan.targetWeightKg,
    activity_level: plan.activityLevel,
    warnings: plan.warnings,
    algorithm_version: plan.algorithmVersion,
  };
}
