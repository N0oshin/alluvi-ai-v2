import { describe, expect, it } from 'vitest';
import { fakeDeps } from '../../../test/app-deps.js';
import { buildApp } from '../../app.js';
import type { ErrorDetail } from '../../http/errors.js';

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

type AnswersBody = Record<string, unknown>;

// A guest with a token, built straight on the stores so each test starts from
// "the person has pressed Get Started" without going through the HTTP route.
async function guestWith(deps: ReturnType<typeof fakeDeps>) {
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
  return { guestSession, headers: { authorization: `Bearer ${guestToken}` } };
}

function put(app: ReturnType<typeof buildApp>, headers: Record<string, string>, body?: object) {
  return app.inject({
    method: 'PUT',
    url: '/v1/onboarding/responses',
    headers,
    ...(body === undefined ? {} : { payload: body }),
  });
}

describe('PUT /v1/onboarding/responses', () => {
  it('saves one screen and returns the whole object with the rest null', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const { headers } = await guestWith(deps);

    const response = await put(app, headers, { sex: 'female' });
    expect(response.statusCode).toBe(200);
    const body = response.json<AnswersBody>();
    expect(body['sex']).toBe('female');
    expect(body['goal']).toBeNull();
    expect(body['obstacle']).toBeNull();
    expect(body['completed_at']).toBeNull();
  });

  it('keeps earlier answers when a later screen saves, and overwrites an answer sent again', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const { headers } = await guestWith(deps);

    await put(app, headers, { sex: 'female', goal: 'lose' });
    await put(app, headers, { obstacle: 'consistency', goal: 'maintain' });
    const body = (await put(app, headers, { motivation: 'energy_mood' })).json<AnswersBody>();

    expect(body).toMatchObject({
      sex: 'female',
      goal: 'maintain',
      obstacle: 'consistency',
      motivation: 'energy_mood',
    });
  });

  it('stores obstacle and motivation as single values and the target weight from the new screen', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const { headers } = await guestWith(deps);

    const body = (
      await put(app, headers, {
        obstacle: 'busy_schedule',
        motivation: 'body_confidence',
        target_weight_kg: 65,
      })
    ).json<AnswersBody>();
    expect(body).toMatchObject({
      obstacle: 'busy_schedule',
      motivation: 'body_confidence',
      target_weight_kg: 65,
    });

    // The old multi-select shape is not accepted.
    const many = await put(app, headers, { obstacle: ['consistency', 'support'] });
    expect(many.statusCode).toBe(422);
  });

  it('accepts every field of the contract in one request', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const { headers } = await guestWith(deps);
    const all = {
      sex: 'female',
      workout_frequency: '3_5',
      birth_date: '1998-03-14',
      acquisition_source: 'instagram',
      tried_other_apps: true,
      unit_system: 'imperial',
      height_cm: 170.2,
      weight_kg: 72.6,
      works_with_professional: false,
      goal: 'lose',
      target_weight_kg: 65.0,
      obstacle: 'consistency',
      motivation: 'energy_mood',
      sync_workouts: true,
      add_burned_calories: false,
      rollover_calories: true,
    };
    const response = await put(app, headers, all);
    expect(response.statusCode).toBe(200);
    expect(response.json<AnswersBody>()).toMatchObject(all);
  });

  it('treats an empty object as a read', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const { headers } = await guestWith(deps);
    await put(app, headers, { weight_kg: 59.4 });

    const body = (await put(app, headers, {})).json<AnswersBody>();
    expect(body['weight_kg']).toBe(59.4);
  });

  it('keeps each guest’s answers separate', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const a = await guestWith(deps);
    const b = await guestWith(deps);

    await put(app, a.headers, { goal: 'lose' });
    const other = (await put(app, b.headers, {})).json<AnswersBody>();
    expect(other['goal']).toBeNull();
  });

  it('works for a signed-in user, with their own row', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const token = await deps.accessTokens.issue({ userId: 'user-1', sessionId: 'session-1' });
    const headers = { authorization: `Bearer ${token}` };

    const body = (await put(app, headers, { goal: 'gain' })).json<AnswersBody>();
    expect(body['goal']).toBe('gain');
  });

  it('answers 401 without a token', async () => {
    const app = buildApp(fakeDeps());
    const response = await put(app, {}, { sex: 'female' });
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('unauthenticated');
  });

  it('answers 422 with the field named for an unknown value, a wrong type and a bad date', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const { headers } = await guestWith(deps);

    const response = await put(app, headers, {
      sex: 'robot',
      tried_other_apps: 'yes',
      birth_date: '1998-02-31',
    });
    expect(response.statusCode).toBe(422);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('validation_failed');
    expect(error.details.map((d) => d.field).sort()).toEqual([
      'birth_date',
      'sex',
      'tried_other_apps',
    ]);
  });

  it('refuses null (an answer cannot be taken back) and unknown fields', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const { headers } = await guestWith(deps);

    expect((await put(app, headers, { goal: null })).statusCode).toBe(422);
    const unknown = await put(app, headers, { favourite_colour: 'blue' });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json<ErrorBody>().error.details[0]?.code).toBe('unknown_field');
  });

  it('answers 422 when there is no body at all', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const { headers } = await guestWith(deps);
    expect((await put(app, headers)).statusCode).toBe(422);
  });
});
