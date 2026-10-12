// Questionnaire answers on the `onboarding_responses` table.
//
// One row per owner: a guest session while the person is answering, or a user
// once they have signed up. `save` is an upsert, so the first screen creates
// the row and every later screen updates it. Only the answers a request names
// are written; the rest keep what they had (that is what makes a partial
// update partial).

import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Executor } from './idempotency-store.js';
import { onboardingResponses } from './schema/index.js';

type Row = typeof onboardingResponses.$inferSelect;
export type OnboardingResponse = Omit<Row, 'createdAt' | 'updatedAt' | 'guestSessionId' | 'userId'>;

type AnswerKey = Exclude<keyof OnboardingResponse, 'id' | 'completedAt'>;

export type OnboardingAnswers = {
  [K in AnswerKey]?: NonNullable<OnboardingResponse[K]> | undefined;
};

export type OnboardingOwner = { guestSessionId: string } | { userId: string };

export interface OnboardingStore {
  // Creates the owner's row if it does not exist, writes the answers that are
  // present in `answers`, and resolves to the whole row afterwards. An empty
  // `answers` is a plain read that also creates the row.
  //
  // `completedAt` is not an answer, so it is a separate argument: a Date marks
  // the questionnaire complete, null marks it incomplete again, and leaving it
  // out keeps what is stored.
  save(
    owner: OnboardingOwner,
    answers: OnboardingAnswers,
    now: Date,
    completedAt?: Date | null,
  ): Promise<OnboardingResponse>;
  // The owner's stored answers, or null if they have not saved any yet. The
  // route reads them to check a new answer against the ones already given.
  find(owner: OnboardingOwner): Promise<OnboardingResponse | null>;
  // The same row looked up by its own id. The worker has the id from the plan
  // generation, not an owner.
  findById(id: string): Promise<OnboardingResponse | null>;
}

const keyOf = (owner: OnboardingOwner): string =>
  'guestSessionId' in owner ? `guest:${owner.guestSessionId}` : `user:${owner.userId}`;

type Changes = Partial<typeof onboardingResponses.$inferInsert>;

// Drops the keys whose value is undefined, so an answer that was not sent
// stays out of the insert and out of the `set` of the update.
function definedOnly(answers: OnboardingAnswers): Changes {
  return Object.fromEntries(Object.entries(answers).filter(([, value]) => value !== undefined));
}

function toResponse(row: Row): OnboardingResponse {
  return {
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
  };
}

export function createOnboardingStore(db: Executor): OnboardingStore {
  return {
    async save(owner, answers, now, completedAt) {
      const changes: Changes = {
        ...definedOnly(answers),
        ...(completedAt === undefined ? {} : { completedAt }),
      };
      // `insert ... on conflict do update` is one statement, so two requests
      // arriving together cannot both try to insert and have one fail.
      // (Backend notes entry 42.) `updated_at` is set by hand because Drizzle's
      // $onUpdate hook only runs for plain updates, not for this form.
      const [row] = await db
        .insert(onboardingResponses)
        .values({ ...owner, ...changes })
        .onConflictDoUpdate({
          target:
            'guestSessionId' in owner
              ? onboardingResponses.guestSessionId
              : onboardingResponses.userId,
          set: { ...changes, updatedAt: now },
        })
        .returning();
      if (row === undefined) throw new Error('onboarding response upsert returned no row');
      return toResponse(row);
    },

    async find(owner) {
      const row = await db.query.onboardingResponses.findFirst({
        where:
          'guestSessionId' in owner
            ? eq(onboardingResponses.guestSessionId, owner.guestSessionId)
            : eq(onboardingResponses.userId, owner.userId),
      });
      return row === undefined ? null : toResponse(row);
    },

    async findById(id) {
      const row = await db.query.onboardingResponses.findFirst({
        where: eq(onboardingResponses.id, id),
      });
      return row === undefined ? null : toResponse(row);
    },
  };
}

// In-memory store with the same rules, for tests and for running the app
// without a database.
export function memoryOnboardingStore(): OnboardingStore {
  const rows = new Map<string, OnboardingResponse>();

  return {
    find(owner) {
      const row = rows.get(keyOf(owner));
      return Promise.resolve(row === undefined ? null : { ...row });
    },

    findById(id) {
      const row = [...rows.values()].find((candidate) => candidate.id === id);
      return Promise.resolve(row === undefined ? null : { ...row });
    },

    save(owner, answers, _now, completedAt) {
      const key = keyOf(owner);
      const current = rows.get(key) ?? { ...toResponse(emptyRow()), id: uuidv7() };
      // definedOnly has already dropped the undefined values, which the type of
      // a spread cannot know; Object.assign copies exactly the keys present.
      const next: OnboardingResponse = Object.assign(
        { ...current },
        definedOnly(answers),
        completedAt === undefined ? {} : { completedAt },
      );
      rows.set(key, next);
      return Promise.resolve({ ...next });
    },
  };
}

function emptyRow(): Row {
  const now = new Date();
  return {
    id: '',
    createdAt: now,
    updatedAt: now,
    guestSessionId: null,
    userId: null,
    sex: null,
    workoutFrequency: null,
    birthDate: null,
    acquisitionSource: null,
    triedOtherApps: null,
    heightCm: null,
    weightKg: null,
    targetWeightKg: null,
    worksWithProfessional: null,
    goal: null,
    obstacle: null,
    motivation: null,
    syncWorkouts: null,
    addBurnedCalories: null,
    rolloverCalories: null,
    unitSystem: null,
    completedAt: null,
  };
}
