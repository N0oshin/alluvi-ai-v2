// Every database call the onboarding module makes, on its own tables
// (schema.ts): the questionnaire answers and the plan generations built from
// them.

import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { type EnumValue, planStepEnum } from '../../shared/schema.js';
import { onboardingResponses, planGenerations } from './schema.js';

// ---------------------------------------------------------------------------
// Questionnaire answers
//
// One row per owner: a guest session while the person is answering, or a
// user once they have signed up. Saving is an upsert, so the first screen
// creates the row and every later screen updates it. Only the answers a
// request names are written; the rest keep what they had.

type ResponseRow = typeof onboardingResponses.$inferSelect;

export type OnboardingResponse = Omit<
  ResponseRow,
  'createdAt' | 'updatedAt' | 'guestSessionId' | 'userId'
>;

type AnswerKey = Exclude<keyof OnboardingResponse, 'id' | 'completedAt'>;

export type OnboardingAnswers = {
  [K in AnswerKey]?: NonNullable<OnboardingResponse[K]> | undefined;
};

export type OnboardingOwner = { guestSessionId: string } | { userId: string };

const toResponse = (row: ResponseRow): OnboardingResponse => ({
  id: row.id,
  sex: row.sex,
  workoutFrequency: row.workoutFrequency,
  birthDate: row.birthDate,
  acquisitionSource: row.acquisitionSource,
  triedOtherApps: row.triedOtherApps,
  heightCm: row.heightCm,
  weightKg: row.weightKg,
  targetWeightKg: row.targetWeightKg,
  worksWithProfessional: row.worksWithProfessional,
  goal: row.goal,
  obstacle: row.obstacle,
  motivation: row.motivation,
  syncWorkouts: row.syncWorkouts,
  addBurnedCalories: row.addBurnedCalories,
  rolloverCalories: row.rolloverCalories,
  unitSystem: row.unitSystem,
  completedAt: row.completedAt,
});

const ownerIs = (owner: OnboardingOwner) =>
  'guestSessionId' in owner
    ? eq(onboardingResponses.guestSessionId, owner.guestSessionId)
    : eq(onboardingResponses.userId, owner.userId);

// Creates the owner's row if it does not exist, writes the answers present in
// `answers`, and resolves to the whole row afterwards. `completedAt` is not
// an answer: a Date marks the questionnaire complete, null marks it
// incomplete again, and leaving it out keeps what is stored.
export async function saveOnboardingResponse(
  owner: OnboardingOwner,
  answers: OnboardingAnswers,
  now: Date,
  completedAt?: Date | null,
): Promise<OnboardingResponse> {
  // Keys whose value is undefined stay out of the insert and of the update's
  // `set`, which is what makes a partial update partial.
  const changes: Partial<typeof onboardingResponses.$inferInsert> = {
    ...Object.fromEntries(Object.entries(answers).filter(([, value]) => value !== undefined)),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
  // One statement, so two requests arriving together cannot both insert.
  // `updatedAt` is set by hand because Drizzle's $onUpdate hook only runs for
  // plain updates, not for this form (backend notes, entry 42).
  const [row] = await db
    .insert(onboardingResponses)
    .values({ ...owner, ...changes })
    .onConflictDoUpdate({
      target:
        'guestSessionId' in owner ? onboardingResponses.guestSessionId : onboardingResponses.userId,
      set: { ...changes, updatedAt: now },
    })
    .returning();
  if (row === undefined) throw new Error('onboarding response upsert returned no row');
  return toResponse(row);
}

// The owner's stored answers, or null if they have not saved any yet.
export async function findOnboardingResponse(
  owner: OnboardingOwner,
): Promise<OnboardingResponse | null> {
  const row = await db.query.onboardingResponses.findFirst({ where: ownerIs(owner) });
  return row === undefined ? null : toResponse(row);
}

// The same row by its own id. The worker has the id from the plan
// generation, not an owner.
export async function findOnboardingResponseById(id: string): Promise<OnboardingResponse | null> {
  const row = await db.query.onboardingResponses.findFirst({
    where: eq(onboardingResponses.id, id),
  });
  return row === undefined ? null : toResponse(row);
}

// ---------------------------------------------------------------------------
// Plan generations
//
// One attempt to build a plan from a set of answers (state machine in
// document 01 section 6.2). A retry after a failure is a new row. The route
// creates a generation; the worker moves it queued -> running -> completed or
// failed. Every worker update is guarded by the current status, so a finished
// generation can never be changed again (a late retry of the job is harmless).

export type PlanGeneration = typeof planGenerations.$inferSelect;
export type PlanStep = EnumValue<typeof planStepEnum>;

const UNFINISHED = ['queued', 'running'] as const;
const ALL_STEPS: PlanStep[] = [...planStepEnum.enumValues];

// A new `queued` generation at 0% with no steps done.
export async function createPlanGeneration(onboardingResponseId: string): Promise<PlanGeneration> {
  const [row] = await db.insert(planGenerations).values({ onboardingResponseId }).returning();
  if (row === undefined) throw new Error('plan generation insert returned no row');
  return row;
}

// The latest generation for these answers that has not finished, or null.
export async function findActivePlanGeneration(
  onboardingResponseId: string,
): Promise<PlanGeneration | null> {
  const row = await db.query.planGenerations.findFirst({
    where: and(
      eq(planGenerations.onboardingResponseId, onboardingResponseId),
      inArray(planGenerations.status, [...UNFINISHED]),
    ),
    orderBy: desc(planGenerations.createdAt),
  });
  return row ?? null;
}

export async function findPlanGenerationById(id: string): Promise<PlanGeneration | null> {
  const row = await db.query.planGenerations.findFirst({ where: eq(planGenerations.id, id) });
  return row ?? null;
}

// queued or running -> running at 0% with no steps done. Null when the
// generation does not exist or has already finished. A retry of the job
// starts here again, from the beginning.
export async function startPlanGeneration(id: string, now: Date): Promise<PlanGeneration | null> {
  const [row] = await db
    .update(planGenerations)
    .set({ status: 'running', progressPct: 0, stepsCompleted: [], updatedAt: now })
    .where(and(eq(planGenerations.id, id), inArray(planGenerations.status, [...UNFINISHED])))
    .returning();
  return row ?? null;
}

// running -> running with more steps ticked. Resolves to whether a row changed.
export async function recordPlanSteps(
  id: string,
  stepsCompleted: PlanStep[],
  progressPct: number,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(planGenerations)
    .set({ stepsCompleted, progressPct, updatedAt: now })
    .where(and(eq(planGenerations.id, id), eq(planGenerations.status, 'running')))
    .returning({ id: planGenerations.id });
  return rows.length > 0;
}

// running -> completed at 100% with all five steps ticked and the result.
export async function completePlanGeneration(
  id: string,
  outcome: { result: unknown; algorithmVersion: string },
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(planGenerations)
    .set({
      status: 'completed',
      progressPct: 100,
      stepsCompleted: ALL_STEPS,
      result: outcome.result,
      algorithmVersion: outcome.algorithmVersion,
      updatedAt: now,
    })
    .where(and(eq(planGenerations.id, id), eq(planGenerations.status, 'running')))
    .returning({ id: planGenerations.id });
  return rows.length > 0;
}

// queued or running -> failed, with the code the client receives.
export async function failPlanGeneration(
  id: string,
  failureCode: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(planGenerations)
    .set({ status: 'failed', failureCode, updatedAt: now })
    .where(and(eq(planGenerations.id, id), inArray(planGenerations.status, [...UNFINISHED])))
    .returning({ id: planGenerations.id });
  return rows.length > 0;
}
