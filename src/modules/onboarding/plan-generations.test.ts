import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeDeps } from '../../../test/app-deps.js';
import { buildApp } from '../../app.js';
import type { OnboardingAnswers } from '../../db/onboarding-store.js';
import type { ErrorDetail } from '../../shared/http/errors.js';
import type { JobPayloads } from '../../jobs/definitions.js';
import { memoryJobQueue } from '../../jobs/queue.js';

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

interface GenerationBody {
  id: string;
  status: string;
  progress_pct: number;
  steps: { key: string; done: boolean }[];
}

const everyRequired: OnboardingAnswers = {
  sex: 'female',
  workoutFrequency: '3_5',
  birthDate: '1998-03-14',
  unitSystem: 'metric',
  heightCm: 170.2,
  weightKg: 72.6,
  targetWeightKg: 65,
  goal: 'lose',
};

// An app with a recording job queue, and a guest who has pressed Get Started.
async function setup() {
  const jobs = memoryJobQueue<JobPayloads>();
  const deps = fakeDeps({ jobs });
  const app = buildApp(deps);

  const now = new Date();
  const device = await deps.devices.register(
    {
      installId: `install-${Math.random()}-0000`,
      platform: 'ios',
      appVersion: '1',
      osVersion: '1',
    },
    now,
  );
  const { guestSession, guestToken } = await deps.guestSessions.create(device.id, now);
  const headers = { authorization: `Bearer ${guestToken}` };
  return { deps, app, jobs, guestSession, headers };
}

function post(
  app: ReturnType<typeof buildApp>,
  headers: Record<string, string>,
  key: string | undefined = randomUUID(),
) {
  return app.inject({
    method: 'POST',
    url: '/v1/onboarding/plan-generations',
    headers: key === undefined ? headers : { ...headers, 'idempotency-key': key },
  });
}

describe('POST /v1/onboarding/plan-generations', () => {
  it('answers 202 with a queued generation and the five steps not done', async () => {
    const { deps, app, guestSession, headers } = await setup();
    await deps.onboarding.save({ guestSessionId: guestSession.id }, everyRequired, new Date());

    const response = await post(app, headers);
    expect(response.statusCode).toBe(202);
    const body = response.json<GenerationBody>();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toMatchObject({ status: 'queued', progress_pct: 0 });
    expect(body.steps).toEqual([
      { key: 'calories', done: false },
      { key: 'carbs', done: false },
      { key: 'protein', done: false },
      { key: 'fats', done: false },
      { key: 'health_score', done: false },
    ]);
  });

  it('stores the generation against the onboarding answers and enqueues the job', async () => {
    const { deps, app, jobs, guestSession, headers } = await setup();
    const saved = await deps.onboarding.save(
      { guestSessionId: guestSession.id },
      everyRequired,
      new Date(),
    );

    const body = (await post(app, headers)).json<GenerationBody>();

    const row = await deps.planGenerations.findActive(saved.id);
    expect(row).toMatchObject({ id: body.id, status: 'queued', progressPct: 0 });
    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0]).toMatchObject({
      name: 'onboarding.generate_plan',
      payload: { planGenerationId: body.id },
    });
  });

  it('answers 409 onboarding_incomplete and names every missing answer', async () => {
    const { deps, app, jobs, guestSession, headers } = await setup();
    await deps.onboarding.save(
      { guestSessionId: guestSession.id },
      { sex: 'female', heightCm: 170.2 },
      new Date(),
    );

    const response = await post(app, headers);
    expect(response.statusCode).toBe(409);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('onboarding_incomplete');
    expect(error.details.map((d) => d.field)).toEqual([
      'workout_frequency',
      'birth_date',
      'unit_system',
      'weight_kg',
      'target_weight_kg',
      'goal',
    ]);
    expect(jobs.jobs).toHaveLength(0);
  });

  it('answers 409 listing all eight when no answer was ever saved', async () => {
    const { app, headers } = await setup();
    const response = await post(app, headers);
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.details).toHaveLength(8);
  });

  it('returns the running generation instead of starting a second one', async () => {
    const { deps, app, jobs, guestSession, headers } = await setup();
    await deps.onboarding.save({ guestSessionId: guestSession.id }, everyRequired, new Date());

    const first = (await post(app, headers)).json<GenerationBody>();
    const second = (await post(app, headers)).json<GenerationBody>();

    expect(second.id).toBe(first.id);
    expect(jobs.jobs).toHaveLength(1);
  });

  it('replays the same response for the same Idempotency-Key', async () => {
    const { deps, app, jobs, guestSession, headers } = await setup();
    await deps.onboarding.save({ guestSessionId: guestSession.id }, everyRequired, new Date());
    const key = randomUUID();

    const first = await post(app, headers, key);
    const replay = await post(app, headers, key);

    expect(replay.statusCode).toBe(202);
    expect(replay.json<GenerationBody>().id).toBe(first.json<GenerationBody>().id);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(jobs.jobs).toHaveLength(1);
  });

  it('answers 422 without an Idempotency-Key', async () => {
    const { deps, app, guestSession, headers } = await setup();
    await deps.onboarding.save({ guestSessionId: guestSession.id }, everyRequired, new Date());

    const response = await post(app, headers, undefined);
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.code).toBe('validation_failed');
  });

  it('answers 401 without a token', async () => {
    const { app } = await setup();
    const response = await post(app, {});
    expect(response.statusCode).toBe(401);
  });

  it('works for a signed-in user with their own answers', async () => {
    const jobs = memoryJobQueue<JobPayloads>();
    const deps = fakeDeps({ jobs });
    const app = buildApp(deps);
    const token = await deps.accessTokens.issue({ userId: 'user-9', sessionId: 'session-9' });
    const headers = { authorization: `Bearer ${token}` };
    await deps.onboarding.save({ userId: 'user-9' }, everyRequired, new Date());

    const response = await post(app, headers);
    expect(response.statusCode).toBe(202);
    expect(jobs.jobs).toHaveLength(1);
  });

  it('does not let one guest start a build from another guest’s answers', async () => {
    const { deps, app, guestSession } = await setup();
    await deps.onboarding.save({ guestSessionId: guestSession.id }, everyRequired, new Date());

    // A second guest with nothing saved.
    const device = await deps.devices.register(
      {
        installId: `install-${Math.random()}-0000`,
        platform: 'ios',
        appVersion: '1',
        osVersion: '1',
      },
      new Date(),
    );
    const other = await deps.guestSessions.create(device.id, new Date());
    const response = await post(app, { authorization: `Bearer ${other.guestToken}` });
    expect(response.statusCode).toBe(409);
  });
});

interface DetailBody extends GenerationBody {
  result: Record<string, unknown> | null;
  failure_code: string | null;
}

function get(app: ReturnType<typeof buildApp>, headers: Record<string, string>, id: string) {
  return app.inject({ method: 'GET', url: `/v1/onboarding/plan-generations/${id}`, headers });
}

describe('GET /v1/onboarding/plan-generations/{id}', () => {
  async function withGeneration() {
    const ctx = await setup();
    const saved = await ctx.deps.onboarding.save(
      { guestSessionId: ctx.guestSession.id },
      everyRequired,
      new Date(),
    );
    const generation = await ctx.deps.planGenerations.create(saved.id, new Date());
    return { ...ctx, generation };
  }

  it('returns a queued generation with the steps not done and no result', async () => {
    const { app, headers, generation } = await withGeneration();

    const response = await get(app, headers, generation.id);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<DetailBody>();
    expect(body).toMatchObject({
      id: generation.id,
      status: 'queued',
      progress_pct: 0,
      result: null,
      failure_code: null,
    });
    expect(body.steps.every((step) => !step.done)).toBe(true);
  });

  it('shows the steps ticked so far while running', async () => {
    const { deps, app, headers, generation } = await withGeneration();
    const at = new Date();
    await deps.planGenerations.start(generation.id, at);
    await deps.planGenerations.recordSteps(generation.id, ['calories', 'carbs'], 40, at);

    const body = (await get(app, headers, generation.id)).json<DetailBody>();

    expect(body).toMatchObject({ status: 'running', progress_pct: 40, result: null });
    expect(body.steps.map((step) => step.done)).toEqual([true, true, false, false, false]);
  });

  it('returns the plan once completed', async () => {
    const { deps, app, headers, generation } = await withGeneration();
    const at = new Date();
    await deps.planGenerations.start(generation.id, at);
    await deps.planGenerations.complete(
      generation.id,
      { result: { calories_kcal: 1760, protein_g: 95 }, algorithmVersion: '2026.1' },
      at,
    );

    const body = (await get(app, headers, generation.id)).json<DetailBody>();

    expect(body).toMatchObject({
      status: 'completed',
      progress_pct: 100,
      result: { calories_kcal: 1760, protein_g: 95 },
      failure_code: null,
    });
    expect(body.steps.every((step) => step.done)).toBe(true);
  });

  it('returns the failure code once failed, with no result', async () => {
    const { deps, app, headers, generation } = await withGeneration();
    await deps.planGenerations.fail(generation.id, 'implausible_inputs', new Date());

    const body = (await get(app, headers, generation.id)).json<DetailBody>();

    expect(body).toMatchObject({
      status: 'failed',
      result: null,
      failure_code: 'implausible_inputs',
    });
  });

  it('answers 404 for another guest, the same as for an id that does not exist', async () => {
    const { deps, app, generation } = await withGeneration();
    const device = await deps.devices.register(
      {
        installId: `install-${Math.random()}-0000`,
        platform: 'ios',
        appVersion: '1',
        osVersion: '1',
      },
      new Date(),
    );
    const other = await deps.guestSessions.create(device.id, new Date());
    const otherHeaders = { authorization: `Bearer ${other.guestToken}` };
    // The other guest has answers of their own, so this is not just "no row".
    await deps.onboarding.save(
      { guestSessionId: other.guestSession.id },
      everyRequired,
      new Date(),
    );

    const stranger = await get(app, otherHeaders, generation.id);
    const missing = await get(app, otherHeaders, '019a0000-0000-7000-8000-00000000dead');

    expect(stranger.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(stranger.json<ErrorBody>().error.code).toBe('not_found');
    expect(stranger.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('answers 404 for a caller who has saved no answers at all', async () => {
    const { deps, app, generation } = await withGeneration();
    const device = await deps.devices.register(
      {
        installId: `install-${Math.random()}-0000`,
        platform: 'ios',
        appVersion: '1',
        osVersion: '1',
      },
      new Date(),
    );
    const blank = await deps.guestSessions.create(device.id, new Date());

    const response = await get(app, { authorization: `Bearer ${blank.guestToken}` }, generation.id);
    expect(response.statusCode).toBe(404);
  });

  it('answers 422 for an id that is not a UUID, and 401 without a token', async () => {
    const { app, headers, generation } = await withGeneration();

    const malformed = await get(app, headers, 'not-a-uuid');
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json<ErrorBody>().error.details[0]).toMatchObject({ field: 'id' });

    expect((await get(app, {}, generation.id)).statusCode).toBe(401);
  });

  it('lets a signed-in user read a generation built from their answers', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const token = await deps.accessTokens.issue({ userId: 'user-5', sessionId: 'session-5' });
    const headers = { authorization: `Bearer ${token}` };
    const saved = await deps.onboarding.save({ userId: 'user-5' }, everyRequired, new Date());
    const generation = await deps.planGenerations.create(saved.id, new Date());

    const response = await get(app, headers, generation.id);
    expect(response.statusCode).toBe(200);
    expect(response.json<DetailBody>().id).toBe(generation.id);
  });
});
