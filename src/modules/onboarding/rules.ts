// The questionnaire's business rules as plain functions: no HTTP, no database.
// The route (responses.ts) calls them; the tests call them with a table.

import type { OnboardingResponse } from '../../db/onboarding-store.js';
import type { EnumValue, weightGoalDirectionEnum } from '../../db/schema/index.js';

type Goal = EnumValue<typeof weightGoalDirectionEnum>;

export function targetWeightMatchesGoal(goal: Goal, weightKg: number, targetKg: number): boolean {
  switch (goal) {
    case 'lose':
      return targetKg < weightKg;
    case 'gain':
      return targetKg > weightKg;
    case 'maintain':
      return targetKg === weightKg;
  }
}

// What the person is told, per goal. Shown under the target weight field.
export const TARGET_WEIGHT_MESSAGES: Record<Goal, string> = {
  lose: 'To lose weight, your target must be below your current weight.',
  gain: 'To gain weight, your target must be above your current weight.',
  maintain: 'To maintain your weight, your target must match your current weight.',
};

export const EARLIEST_BIRTH_DATE = '1900-01-01';

// `birthDate` and `today` are both YYYY-MM-DD, which sort as text in the same
// order as they do as dates, so plain string comparison is correct.
export function birthDateProblem(
  birthDate: string,
  today: string,
): 'too_early' | 'in_future' | null {
  if (birthDate < EARLIEST_BIRTH_DATE) return 'too_early';
  if (birthDate > today) return 'in_future';
  return null;
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// The answers a plan cannot be calculated without, in the order the screens
// ask for them (decision 44). Everything else in the questionnaire has a
// default, so a missing answer never blocks someone from getting a plan.
export const REQUIRED_ANSWERS = [
  'sex',
  'workoutFrequency',
  'birthDate',
  'unitSystem',
  'heightCm',
  'weightKg',
  'targetWeightKg',
  'goal',
] as const;

// 'sex' | 'workoutFrequency' | ... built from the list above, so the type and
// the list cannot drift apart (TypeScript notes entries 18 and 39).
export type RequiredAnswer = (typeof REQUIRED_ANSWERS)[number];

// The required answers that are still empty, in screen order. An empty result
// means the questionnaire is complete.
export function missingAnswers(
  answers: Pick<OnboardingResponse, RequiredAnswer>,
): RequiredAnswer[] {
  return REQUIRED_ANSWERS.filter((name) => answers[name] === null);
}
