// Factories for the onboarding tables (src/db/schema/onboarding.ts).

import { v7 as uuidv7 } from 'uuid';
import { onboardingResponses, planGenerations } from '../../src/db/schema.js';
import { defineFactory } from './define.js';

// A fully answered questionnaire belonging to a guest session (the answers
// from the sample screens: a 160 lb woman who wants to lose 5 kg). The guest
// session id defaults to a random id, so `create` needs a real one:
//   const g = await factories.guestSession.create({ deviceId: d.id });
//   await factories.onboardingResponse.create({ guestSessionId: g.id });
// For a claimed row pass `{ guestSessionId: null, userId: u.id }`.
export const onboardingResponse = defineFactory(onboardingResponses, () => ({
  guestSessionId: uuidv7(),
  userId: null,
  sex: 'female' as const,
  workoutFrequency: '3_5' as const,
  birthDate: '1998-03-14',
  acquisitionSource: 'instagram' as const,
  triedOtherApps: true,
  heightCm: 170.2,
  weightKg: 59.4,
  targetWeightKg: 54.4,
  worksWithProfessional: false,
  goal: 'lose' as const,
  obstacle: 'consistency' as const,
  motivation: 'energy_mood' as const,
  syncWorkouts: true,
  addBurnedCalories: false,
  rolloverCalories: true,
  unitSystem: 'metric' as const,
  completedAt: new Date(),
}));

// A generation that was just requested: queued, 0%, nothing ticked. `create`
// needs a real onboarding response.
export const planGeneration = defineFactory(planGenerations, () => ({
  onboardingResponseId: uuidv7(),
  status: 'queued' as const,
  progressPct: 0,
  stepsCompleted: [],
  result: null,
  algorithmVersion: null,
  failureCode: null,
}));
