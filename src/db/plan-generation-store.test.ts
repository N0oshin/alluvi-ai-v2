import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  testDb,
  truncateAll,
} from '../../test/db.js';
import { factories } from '../../test/factories/index.js';
import { createPlanGenerationStore } from './plan-generation-store.js';
import { planGenerations } from './schema/index.js';

describeWithDatabase('createPlanGenerationStore', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  const store = () => createPlanGenerationStore(testDb());

  async function response() {
    const device = await factories.device.create();
    const guest = await factories.guestSession.create({ deviceId: device.id });
    return factories.onboardingResponse.create({ guestSessionId: guest.id });
  }

  it('creates a queued generation at 0% with no steps done', async () => {
    const r = await response();
    const row = await store().create(r.id, new Date());
    expect(row).toMatchObject({
      onboardingResponseId: r.id,
      status: 'queued',
      progressPct: 0,
      stepsCompleted: [],
      result: null,
      algorithmVersion: null,
      failureCode: null,
    });
  });

  it('finds the active generation, and null when there is none', async () => {
    const r = await response();
    expect(await store().findActive(r.id)).toBeNull();

    const created = await store().create(r.id, new Date());
    expect((await store().findActive(r.id))?.id).toBe(created.id);
  });

  it('counts queued and running as active, and completed or failed as finished', async () => {
    const r = await response();
    const row = await store().create(r.id, new Date());

    await testDb()
      .update(planGenerations)
      .set({ status: 'running', progressPct: 24 })
      .where(eq(planGenerations.id, row.id));
    expect((await store().findActive(r.id))?.status).toBe('running');

    await testDb()
      .update(planGenerations)
      .set({ status: 'failed', failureCode: 'timeout' })
      .where(eq(planGenerations.id, row.id));
    expect(await store().findActive(r.id)).toBeNull();
  });

  it('returns the newest active generation and ignores other answers’ generations', async () => {
    const mine = await response();
    const theirs = await response();
    await store().create(theirs.id, new Date());
    const first = await store().create(mine.id, new Date('2026-10-12T10:00:00Z'));
    const second = await store().create(mine.id, new Date('2026-10-12T10:01:00Z'));

    await testDb()
      .update(planGenerations)
      .set({ createdAt: new Date('2026-10-12T10:00:00Z') })
      .where(eq(planGenerations.id, first.id));
    await testDb()
      .update(planGenerations)
      .set({ createdAt: new Date('2026-10-12T10:01:00Z') })
      .where(eq(planGenerations.id, second.id));

    expect((await store().findActive(mine.id))?.id).toBe(second.id);
  });
});

describeWithDatabase('plan generation store: worker updates', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  const store = () => createPlanGenerationStore(testDb());
  const now = new Date('2026-10-12T12:00:00Z');

  async function queued() {
    const device = await factories.device.create();
    const guest = await factories.guestSession.create({ deviceId: device.id });
    const answers = await factories.onboardingResponse.create({ guestSessionId: guest.id });
    return store().create(answers.id, now);
  }

  it('finds a generation by id, and null for an unknown one', async () => {
    const generation = await queued();
    expect((await store().findById(generation.id))?.id).toBe(generation.id);
    expect(await store().findById('019a0000-0000-7000-8000-00000000dead')).toBeNull();
  });

  it('moves queued to running at 0% with no steps', async () => {
    const generation = await queued();
    const started = await store().start(generation.id, now);
    expect(started).toMatchObject({ status: 'running', progressPct: 0, stepsCompleted: [] });
  });

  it('records ticked steps in order, and only while running', async () => {
    const generation = await queued();
    // Still queued: refused.
    expect(await store().recordSteps(generation.id, ['calories'], 20, now)).toBe(false);

    await store().start(generation.id, now);
    expect(await store().recordSteps(generation.id, ['calories', 'carbs'], 40, now)).toBe(true);
    expect(await store().findById(generation.id)).toMatchObject({
      status: 'running',
      progressPct: 40,
      stepsCompleted: ['calories', 'carbs'],
    });
  });

  it('completes with the result, the version, 100% and all five steps', async () => {
    const generation = await queued();
    await store().start(generation.id, now);

    const ok = await store().complete(
      generation.id,
      { result: { calories_kcal: 1760 }, algorithmVersion: '2026.1' },
      now,
    );

    expect(ok).toBe(true);
    expect(await store().findById(generation.id)).toMatchObject({
      status: 'completed',
      progressPct: 100,
      stepsCompleted: ['calories', 'carbs', 'protein', 'fats', 'health_score'],
      result: { calories_kcal: 1760 },
      algorithmVersion: '2026.1',
    });
  });

  it('fails with a code, from queued or from running', async () => {
    const a = await queued();
    expect(await store().fail(a.id, 'onboarding_incomplete', now)).toBe(true);
    expect(await store().findById(a.id)).toMatchObject({
      status: 'failed',
      failureCode: 'onboarding_incomplete',
    });

    const b = await queued();
    await store().start(b.id, now);
    expect(await store().fail(b.id, 'implausible_inputs', now)).toBe(true);
  });

  it('never changes a finished generation', async () => {
    const generation = await queued();
    await store().start(generation.id, now);
    await store().complete(generation.id, { result: {}, algorithmVersion: '2026.1' }, now);

    expect(await store().start(generation.id, now)).toBeNull();
    expect(await store().recordSteps(generation.id, ['calories'], 20, now)).toBe(false);
    expect(await store().fail(generation.id, 'timeout', now)).toBe(false);
    expect((await store().findById(generation.id))?.status).toBe('completed');
  });
});
