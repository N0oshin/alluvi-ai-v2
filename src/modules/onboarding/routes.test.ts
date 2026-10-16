// One test file for the module's routes: the main happy path and the main
// refusal of each endpoint, against the test database.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { fakeDeps } from '../../../test/app-deps.js';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  truncateAll,
} from '../../../test/db.js';
import { factories } from '../../../test/factories/index.js';
import { buildApp } from '../../app.js';
import type { JobPayloads } from '../../jobs/definitions.js';
import { memoryJobQueue } from '../../jobs/queue.js';
import { accessTokens } from '../../shared/auth/access-token.js';
import type { ErrorDetail } from '../../shared/http/errors.js';

type App = ReturnType<typeof buildApp>;

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}
interface ResponsesBody {
  sex: string | null;
  weight_kg: number | null;
  target_weight_kg: number | null;
  completed_at: string | null;
  missing_fields: string[];
}
interface GenerationBody {
  id: string;
  status: string;
  progress_pct: number;
  steps: { key: string; done: boolean }[];
  result?: unknown;
  failure_code?: string | null;
}

// The eight answers a plan needs, as the screens send them.
const complete = {
  sex: 'female',
  workout_frequency: '3_5',
  birth_date: '1998-03-14',
  unit_system: 'metric',
  height_cm: 170.2,
  weight_kg: 59.4,
  target_weight_kg: 54.4,
  goal: 'lose',
};

async function guestToken(app: App): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/guest-sessions',
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      device: {
        platform: 'ios',
        app_version: '1.0.0',
        os_version: '18.0',
        install_id: randomUUID(),
      },
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ guest_token: string }>().guest_token;
}

function put(app: App, token: string, payload: object) {
  return app.inject({
    method: 'PUT',
    url: '/v1/onboarding/responses',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

// `null` means "send no Idempotency-Key"; undefined would take the default.
function startPlan(app: App, token: string, key: string | null = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: '/v1/onboarding/plan-generations',
    headers: {
      authorization: `Bearer ${token}`,
      ...(key === null ? {} : { 'idempotency-key': key }),
    },
    payload: {},
  });
}

function getPlan(app: App, token: string, id: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/onboarding/plan-generations/${id}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describeWithDatabase('onboarding routes', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  it('PUT /v1/onboarding/responses saves one screen at a time and reports what is still missing', async () => {
    const app = buildApp(fakeDeps());
    const token = await guestToken(app);

    const first = await put(app, token, { sex: 'female', weight_kg: 59.44 });
    expect(first.statusCode).toBe(200);
    const body = first.json<ResponsesBody>();
    expect(body.sex).toBe('female');
    expect(body.weight_kg).toBe(59.4);
    expect(body.completed_at).toBeNull();
    expect(body.missing_fields).toEqual([
      'workout_frequency',
      'birth_date',
      'unit_system',
      'height_cm',
      'target_weight_kg',
      'goal',
    ]);

    // The rest of the answers; the earlier ones are kept.
    const { sex: _sex, weight_kg: _weight, ...rest } = complete;
    const second = await put(app, token, rest);
    expect(second.statusCode).toBe(200);
    expect(second.json<ResponsesBody>().missing_fields).toEqual([]);
    expect(second.json<ResponsesBody>().completed_at).not.toBeNull();
  });

  it('PUT refuses a target weight that contradicts the goal', async () => {
    const app = buildApp(fakeDeps());
    const token = await guestToken(app);
    const response = await put(app, token, { goal: 'lose', weight_kg: 60, target_weight_kg: 65 });
    expect(response.statusCode).toBe(422);
    const error = response.json<ErrorBody>().error;
    expect(error.code).toBe('target_weight_inconsistent');
    expect(error.details[0]?.field).toBe('target_weight_kg');
  });

  it('PUT works for a signed-in user as well as a guest', async () => {
    const app = buildApp(fakeDeps());
    const user = await factories.user.create();
    const device = await factories.device.create({ userId: user.id });
    const session = await factories.session.create({ userId: user.id, deviceId: device.id });
    const token = await accessTokens.issue({ userId: user.id, sessionId: session.id });

    const response = await put(app, token, { sex: 'male' });
    expect(response.statusCode).toBe(200);
    expect(response.json<ResponsesBody>().sex).toBe('male');
  });

  it('POST /v1/onboarding/plan-generations needs the full questionnaire and an Idempotency-Key', async () => {
    const app = buildApp(fakeDeps());
    const token = await guestToken(app);

    const noKey = await startPlan(app, token, null);
    expect(noKey.statusCode).toBe(422);
    expect(noKey.json<ErrorBody>().error.details[0]?.field).toBe('Idempotency-Key');

    await put(app, token, { sex: 'female' });
    const incomplete = await startPlan(app, token);
    expect(incomplete.statusCode).toBe(409);
    const error = incomplete.json<ErrorBody>().error;
    expect(error.code).toBe('onboarding_incomplete');
    expect(error.details.map((d) => d.field)).toContain('goal');
  });

  it('POST starts one build, enqueues one job, and a second tap gets the same generation', async () => {
    const jobs = memoryJobQueue<JobPayloads>();
    const app = buildApp(fakeDeps({ jobs }));
    const token = await guestToken(app);
    await put(app, token, complete);

    const first = await startPlan(app, token);
    expect(first.statusCode).toBe(202);
    const generation = first.json<GenerationBody>();
    expect(generation.status).toBe('queued');
    expect(generation.progress_pct).toBe(0);
    expect(generation.steps.map((s) => s.key)).toEqual([
      'calories',
      'carbs',
      'protein',
      'fats',
      'health_score',
    ]);
    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0]?.payload).toEqual({ planGenerationId: generation.id });

    const second = await startPlan(app, token);
    expect(second.statusCode).toBe(202);
    expect(second.json<GenerationBody>().id).toBe(generation.id);
    expect(jobs.jobs).toHaveLength(1);
  });

  it('GET /v1/onboarding/plan-generations/{id} is readable by its owner only', async () => {
    const app = buildApp(fakeDeps());
    const token = await guestToken(app);
    await put(app, token, complete);
    const { id } = (await startPlan(app, token)).json<GenerationBody>();

    const mine = await getPlan(app, token, id);
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['cache-control']).toBe('no-store');
    expect(mine.json<GenerationBody>()).toMatchObject({ id, result: null, failure_code: null });

    const other = await guestToken(app);
    const theirs = await getPlan(app, other, id);
    expect(theirs.statusCode).toBe(404);

    const missing = await getPlan(app, token, randomUUID());
    expect(missing.statusCode).toBe(404);
  });
});
