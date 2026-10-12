import { eq, getTableColumns, getTableName } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { factories } from '../../../test/factories/index.js';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  testDb,
  truncateAll,
} from '../../../test/db.js';
import { guestSessions, users } from './identity.js';
import { onboardingResponses, planGenerations } from './onboarding.js';

const casing = new CasingCache('snake_case');

// The name of the constraint a failed insert or update broke; Drizzle keeps the
// PostgreSQL error as `cause` (same helper as identity.test.ts).
async function violatedConstraint(query: Promise<unknown>): Promise<string | undefined> {
  try {
    await query;
    return undefined;
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint;
  }
}
const columnName = (column: Parameters<CasingCache['getColumnCasing']>[0]) =>
  casing.getColumnCasing(column);

describe('onboarding_responses', () => {
  const columns = getTableColumns(onboardingResponses);

  it('has the base columns, the two owners and the sixteen answers', () => {
    expect(getTableName(onboardingResponses)).toBe('onboarding_responses');
    expect(Object.keys(columns).sort()).toEqual(
      [
        'id',
        'createdAt',
        'updatedAt',
        'guestSessionId',
        'userId',
        'sex',
        'workoutFrequency',
        'birthDate',
        'acquisitionSource',
        'triedOtherApps',
        'heightCm',
        'weightKg',
        'targetWeightKg',
        'worksWithProfessional',
        'goal',
        'obstacle',
        'motivation',
        'syncWorkouts',
        'addBurnedCalories',
        'rolloverCalories',
        'unitSystem',
        'completedAt',
      ].sort(),
    );
    expect(columnName(columns.targetWeightKg)).toBe('target_weight_kg');
    expect(columnName(columns.worksWithProfessional)).toBe('works_with_professional');
  });

  it('allows every answer to be missing, so a screen can save alone', () => {
    const answers = Object.entries(columns)
      .filter(([name]) => !['id', 'createdAt', 'updatedAt'].includes(name))
      .filter(([, column]) => column.notNull);
    expect(answers).toEqual([]);
  });

  it('stores single-choice obstacle and motivation as one enum value each', () => {
    expect(columns.obstacle.dataType).toBe('string');
    expect(columns.motivation.dataType).toBe('string');
    expect(columns.obstacle.getSQLType()).toBe('obstacle');
    expect(columns.motivation.getSQLType()).toBe('motivation');
  });

  it('keeps heights and weights at the precisions of document 01', () => {
    expect(columns.heightCm.getSQLType()).toBe('numeric(5, 2)');
    expect(columns.weightKg.getSQLType()).toBe('numeric(5, 1)');
    expect(columns.targetWeightKg.getSQLType()).toBe('numeric(5, 1)');
  });

  it('cascades from guest_sessions and users, each unique, with the one-owner check', () => {
    const config = getTableConfig(onboardingResponses);
    const targets = config.foreignKeys.map((fk) => [
      getTableName(fk.reference().foreignTable),
      fk.onDelete,
    ]);
    expect(targets.sort()).toEqual([
      ['guest_sessions', 'cascade'],
      ['users', 'cascade'],
    ]);
    expect(config.indexes.map((i) => [i.config.name, i.config.unique])).toEqual([
      ['onboarding_responses_guest_session_id', true],
      ['onboarding_responses_user_id', true],
    ]);
    expect(config.checks.map((c) => c.name).sort()).toEqual([
      'onboarding_responses_birth_date_floor',
      'onboarding_responses_height_range',
      'onboarding_responses_one_owner',
      'onboarding_responses_target_weight_range',
      'onboarding_responses_weight_range',
    ]);
  });
});

describeWithDatabase('onboarding_responses in the database', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  async function guest() {
    const device = await factories.device.create();
    return factories.guestSession.create({ deviceId: device.id });
  }

  it('stores a full set of answers for a guest session and returns numbers as numbers', async () => {
    const g = await guest();
    const row = await factories.onboardingResponse.create({ guestSessionId: g.id });
    expect(row.userId).toBeNull();
    expect(row.goal).toBe('lose');
    expect(row.heightCm).toBe(170.2);
    expect(row.targetWeightKg).toBe(54.4);
    expect(row.birthDate).toBe('1998-03-14');
  });

  it('accepts a row with no answers at all', async () => {
    const g = await guest();
    const row = await testDb()
      .insert(onboardingResponses)
      .values({ guestSessionId: g.id })
      .returning();
    expect(row[0]?.sex).toBeNull();
    expect(row[0]?.completedAt).toBeNull();
  });

  it('refuses a second row for the same guest session or the same user', async () => {
    const g = await guest();
    await factories.onboardingResponse.create({ guestSessionId: g.id });
    expect(
      await violatedConstraint(factories.onboardingResponse.create({ guestSessionId: g.id })),
    ).toBe('onboarding_responses_guest_session_id');

    const user = await factories.user.create();
    await factories.onboardingResponse.create({ guestSessionId: null, userId: user.id });
    expect(
      await violatedConstraint(
        factories.onboardingResponse.create({ guestSessionId: null, userId: user.id }),
      ),
    ).toBe('onboarding_responses_user_id');
  });

  it('requires exactly one owner', async () => {
    const g = await guest();
    const user = await factories.user.create();
    expect(
      await violatedConstraint(
        factories.onboardingResponse.create({ guestSessionId: null, userId: null }),
      ),
    ).toBe('onboarding_responses_one_owner');
    expect(
      await violatedConstraint(
        factories.onboardingResponse.create({ guestSessionId: g.id, userId: user.id }),
      ),
    ).toBe('onboarding_responses_one_owner');
  });

  it('moves to the user on claim: set user, clear guest session', async () => {
    const g = await guest();
    const user = await factories.user.create();
    const row = await factories.onboardingResponse.create({ guestSessionId: g.id });
    await testDb()
      .update(onboardingResponses)
      .set({ userId: user.id, guestSessionId: null })
      .where(eq(onboardingResponses.id, row.id));
    // The purge job deleting the guest session must now leave the answers alone.
    await testDb().delete(guestSessions).where(eq(guestSessions.id, g.id));
    const [after] = await testDb()
      .select()
      .from(onboardingResponses)
      .where(eq(onboardingResponses.id, row.id));
    expect(after?.userId).toBe(user.id);
  });

  it('is deleted with an unclaimed guest session and with its user', async () => {
    const g = await guest();
    await factories.onboardingResponse.create({ guestSessionId: g.id });
    await testDb().delete(guestSessions).where(eq(guestSessions.id, g.id));
    expect(await testDb().select().from(onboardingResponses)).toHaveLength(0);

    const user = await factories.user.create();
    await factories.onboardingResponse.create({ guestSessionId: null, userId: user.id });
    await testDb().delete(users).where(eq(users.id, user.id));
    expect(await testDb().select().from(onboardingResponses)).toHaveLength(0);
  });

  it('refuses a height, weight or birth date outside the bounds', async () => {
    const make = (overrides: Parameters<typeof factories.onboardingResponse.create>[0]) =>
      guest().then((g) =>
        factories.onboardingResponse.create({ guestSessionId: g.id, ...overrides }),
      );
    expect(await violatedConstraint(make({ heightCm: 89 }))).toBe(
      'onboarding_responses_height_range',
    );
    expect(await violatedConstraint(make({ weightKg: 19.9 }))).toBe(
      'onboarding_responses_weight_range',
    );
    expect(await violatedConstraint(make({ targetWeightKg: 401 }))).toBe(
      'onboarding_responses_target_weight_range',
    );
    expect(await violatedConstraint(make({ birthDate: '1899-12-31' }))).toBe(
      'onboarding_responses_birth_date_floor',
    );
  });

  it('refuses an acquisition source that is not in the list', async () => {
    const g = await guest();
    const error = await factories.onboardingResponse
      .create({ guestSessionId: g.id, acquisitionSource: 'billboard' as unknown as 'tv' })
      .then(() => undefined)
      .catch((e: unknown) => e);
    const cause = (error as { cause?: { message?: string } }).cause;
    expect(cause?.message).toMatch(/invalid input value for enum acquisition_source/);
  });
});

describe('plan_generations', () => {
  const columns = getTableColumns(planGenerations);

  it('has the base columns and the generation fields', () => {
    expect(getTableName(planGenerations)).toBe('plan_generations');
    expect(Object.keys(columns).sort()).toEqual(
      [
        'id',
        'createdAt',
        'updatedAt',
        'onboardingResponseId',
        'status',
        'progressPct',
        'stepsCompleted',
        'result',
        'algorithmVersion',
        'failureCode',
      ].sort(),
    );
    expect(columnName(columns.onboardingResponseId)).toBe('onboarding_response_id');
    expect(columnName(columns.stepsCompleted)).toBe('steps_completed');
  });

  it('starts queued at 0% with nothing ticked, and only the response is required', () => {
    expect(columns.status.default).toBe('queued');
    expect(columns.progressPct.default).toBe(0);
    expect(columns.stepsCompleted.notNull).toBe(true);
    expect(columns.onboardingResponseId.notNull).toBe(true);
    expect(columns.result.notNull).toBe(false);
    expect(columns.algorithmVersion.notNull).toBe(false);
    expect(columns.failureCode.notNull).toBe(false);
  });

  it('points at onboarding_responses with cascade and has three checks', () => {
    const config = getTableConfig(planGenerations);
    expect(
      config.foreignKeys.map((fk) => [getTableName(fk.reference().foreignTable), fk.onDelete]),
    ).toEqual([['onboarding_responses', 'cascade']]);
    expect(config.indexes.map((i) => [i.config.name, i.config.unique])).toEqual([
      ['plan_generations_response_created', false],
    ]);
    expect(config.checks.map((c) => c.name).sort()).toEqual([
      'plan_generations_completed_has_result',
      'plan_generations_failed_has_code',
      'plan_generations_progress_range',
    ]);
  });
});

describeWithDatabase('plan_generations in the database', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  async function response() {
    const device = await factories.device.create();
    const g = await factories.guestSession.create({ deviceId: device.id });
    return factories.onboardingResponse.create({ guestSessionId: g.id });
  }

  it('creates a queued generation with an empty step list', async () => {
    const r = await response();
    const row = await factories.planGeneration.create({ onboardingResponseId: r.id });
    expect(row.status).toBe('queued');
    expect(row.progressPct).toBe(0);
    expect(row.stepsCompleted).toEqual([]);
    expect(row.result).toBeNull();
  });

  it('keeps steps in the order they were written', async () => {
    const r = await response();
    const row = await factories.planGeneration.create({
      onboardingResponseId: r.id,
      status: 'running',
      progressPct: 40,
      stepsCompleted: ['calories', 'carbs'],
    });
    expect(row.stepsCompleted).toEqual(['calories', 'carbs']);
  });

  it('allows several attempts for one set of answers, so a retry is a new row', async () => {
    const r = await response();
    await factories.planGeneration.create({
      onboardingResponseId: r.id,
      status: 'failed',
      failureCode: 'timeout',
    });
    await factories.planGeneration.create({ onboardingResponseId: r.id });
  });

  it('refuses progress outside 0 to 100', async () => {
    const r = await response();
    expect(
      await violatedConstraint(
        factories.planGeneration.create({ onboardingResponseId: r.id, progressPct: 101 }),
      ),
    ).toBe('plan_generations_progress_range');
  });

  it('refuses a completed generation without its result or version, and a failed one without a code', async () => {
    const r = await response();
    expect(
      await violatedConstraint(
        factories.planGeneration.create({ onboardingResponseId: r.id, status: 'completed' }),
      ),
    ).toBe('plan_generations_completed_has_result');
    expect(
      await violatedConstraint(
        factories.planGeneration.create({ onboardingResponseId: r.id, status: 'failed' }),
      ),
    ).toBe('plan_generations_failed_has_code');
    const done = await factories.planGeneration.create({
      onboardingResponseId: r.id,
      status: 'completed',
      progressPct: 100,
      result: { calories_kcal: 2140 },
      algorithmVersion: '2026.1',
    });
    expect(done.result).toEqual({ calories_kcal: 2140 });
  });

  it('refuses an unknown step', async () => {
    const r = await response();
    const error = await factories.planGeneration
      .create({
        onboardingResponseId: r.id,
        stepsCompleted: ['vitamins' as unknown as 'calories'],
      })
      .then(() => undefined)
      .catch((e: unknown) => e);
    const cause = (error as { cause?: { message?: string } }).cause;
    expect(cause?.message).toMatch(/invalid input value for enum plan_step/);
  });

  it('is deleted with its onboarding response', async () => {
    const r = await response();
    await factories.planGeneration.create({ onboardingResponseId: r.id });
    await testDb().delete(onboardingResponses).where(eq(onboardingResponses.id, r.id));
    expect(await testDb().select().from(planGenerations)).toHaveLength(0);
  });
});
