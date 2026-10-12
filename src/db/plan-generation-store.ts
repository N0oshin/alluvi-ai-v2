// Plan generations on the `plan_generations` table: one attempt to build a plan
// from a set of onboarding answers (document 01 section 2.2, state machine in
// section 6.2). A retry after a failure is a new row.
//
// Two callers. The POST route creates a generation and looks for a running
// one. The worker moves it through queued -> running -> completed or failed.
// Every worker update is guarded by the current status, so a finished
// generation can never be changed again (a late retry of the job is harmless).

import { and, desc, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Executor } from './idempotency-store.js';
import { planGenerations, planStepEnum, type EnumValue } from './schema/index.js';

export type PlanGeneration = typeof planGenerations.$inferSelect;
export type PlanStep = EnumValue<typeof planStepEnum>;

export interface PlanGenerationStore {
  // A new `queued` generation at 0% with no steps done.
  create(onboardingResponseId: string, now: Date): Promise<PlanGeneration>;
  // The latest generation for these answers that has not finished (`queued`
  // or `running`), or null. The route returns it instead of starting a second
  // one when the person taps again.
  findActive(onboardingResponseId: string): Promise<PlanGeneration | null>;
  findById(id: string): Promise<PlanGeneration | null>;

  // ---- The worker's updates. Each resolves to whether a row changed. ----

  // queued or running -> running at 0%, with no steps done. Resolves to the
  // generation, or null when it does not exist or has already finished. A
  // retry of the job starts here again, from the beginning.
  start(id: string, now: Date): Promise<PlanGeneration | null>;
  // running -> running with more steps ticked.
  recordSteps(
    id: string,
    stepsCompleted: PlanStep[],
    progressPct: number,
    now: Date,
  ): Promise<boolean>;
  // running -> completed at 100% with all five steps ticked and the result.
  complete(
    id: string,
    outcome: { result: unknown; algorithmVersion: string },
    now: Date,
  ): Promise<boolean>;
  // queued or running -> failed, with the code the client receives.
  fail(id: string, failureCode: string, now: Date): Promise<boolean>;
}

const UNFINISHED = ['queued', 'running'] as const;
const ALL_STEPS: PlanStep[] = [...planStepEnum.enumValues];

export function createPlanGenerationStore(db: Executor): PlanGenerationStore {
  return {
    async create(onboardingResponseId) {
      const [row] = await db.insert(planGenerations).values({ onboardingResponseId }).returning();
      if (row === undefined) throw new Error('plan generation insert returned no row');
      return row;
    },

    async findActive(onboardingResponseId) {
      const row = await db.query.planGenerations.findFirst({
        where: and(
          eq(planGenerations.onboardingResponseId, onboardingResponseId),
          inArray(planGenerations.status, [...UNFINISHED]),
        ),
        orderBy: desc(planGenerations.createdAt),
      });
      return row ?? null;
    },

    async findById(id) {
      const row = await db.query.planGenerations.findFirst({
        where: eq(planGenerations.id, id),
      });
      return row ?? null;
    },

    async start(id, now) {
      const [row] = await db
        .update(planGenerations)
        .set({ status: 'running', progressPct: 0, stepsCompleted: [], updatedAt: now })
        .where(and(eq(planGenerations.id, id), inArray(planGenerations.status, [...UNFINISHED])))
        .returning();
      return row ?? null;
    },

    async recordSteps(id, stepsCompleted, progressPct, now) {
      const rows = await db
        .update(planGenerations)
        .set({ stepsCompleted, progressPct, updatedAt: now })
        .where(and(eq(planGenerations.id, id), eq(planGenerations.status, 'running')))
        .returning({ id: planGenerations.id });
      return rows.length > 0;
    },

    async complete(id, outcome, now) {
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
    },

    async fail(id, failureCode, now) {
      const rows = await db
        .update(planGenerations)
        .set({ status: 'failed', failureCode, updatedAt: now })
        .where(and(eq(planGenerations.id, id), inArray(planGenerations.status, [...UNFINISHED])))
        .returning({ id: planGenerations.id });
      return rows.length > 0;
    },
  };
}

// In-memory store with the same rules, for tests and for running the app
// without a database.
export function memoryPlanGenerationStore(): PlanGenerationStore & {
  readonly rows: PlanGeneration[];
} {
  const rows: PlanGeneration[] = [];
  const find = (id: string) => rows.find((row) => row.id === id);
  const unfinished = (row: PlanGeneration) => row.status === 'queued' || row.status === 'running';

  return {
    rows,

    create(onboardingResponseId, now) {
      const row: PlanGeneration = {
        id: uuidv7(),
        createdAt: now,
        updatedAt: now,
        onboardingResponseId,
        status: 'queued',
        progressPct: 0,
        stepsCompleted: [],
        result: null,
        algorithmVersion: null,
        failureCode: null,
      };
      rows.push(row);
      return Promise.resolve({ ...row });
    },

    findActive(onboardingResponseId) {
      const active = rows
        .filter((row) => row.onboardingResponseId === onboardingResponseId && unfinished(row))
        .at(-1);
      return Promise.resolve(active === undefined ? null : { ...active });
    },

    findById(id) {
      const row = find(id);
      return Promise.resolve(row === undefined ? null : { ...row });
    },

    start(id, now) {
      const row = find(id);
      if (row === undefined || !unfinished(row)) return Promise.resolve(null);
      Object.assign(row, { status: 'running', progressPct: 0, stepsCompleted: [], updatedAt: now });
      return Promise.resolve({ ...row });
    },

    recordSteps(id, stepsCompleted, progressPct, now) {
      const row = find(id);
      if (row === undefined || row.status !== 'running') return Promise.resolve(false);
      Object.assign(row, { stepsCompleted: [...stepsCompleted], progressPct, updatedAt: now });
      return Promise.resolve(true);
    },

    complete(id, outcome, now) {
      const row = find(id);
      if (row === undefined || row.status !== 'running') return Promise.resolve(false);
      Object.assign(row, {
        status: 'completed',
        progressPct: 100,
        stepsCompleted: [...ALL_STEPS],
        result: outcome.result,
        algorithmVersion: outcome.algorithmVersion,
        updatedAt: now,
      });
      return Promise.resolve(true);
    },

    fail(id, failureCode, now) {
      const row = find(id);
      if (row === undefined || !unfinished(row)) return Promise.resolve(false);
      Object.assign(row, { status: 'failed', failureCode, updatedAt: now });
      return Promise.resolve(true);
    },
  };
}
