import { describe, expect, it } from 'vitest';
import { fakeDeps } from '../../../test/app-deps.js';
import { buildApp } from '../../app.js';
import type { ErrorDetail } from '../../shared/http/errors.js';

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

  it('answers 422 out_of_range, naming the field, for height and weights outside the bounds', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const { headers } = await guestWith(deps);

    for (const body of [
      { height_cm: 89 },
      { height_cm: 251 },
      { weight_kg: 19.9 },
      { weight_kg: 400.1 },
      { target_weight_kg: 5 },
    ]) {
      const response = await put(app, headers, body);
      expect(response.statusCode).toBe(422);
      const { error } = response.json<ErrorBody>();
      expect(error.code).toBe('validation_failed');
      expect(error.details).toHaveLength(1);
      expect(error.details[0]).toMatchObject({
        field: Object.keys(body)[0],
        code: 'out_of_range',
      });
    }
    // The edges themselves are fine.
    expect(
      (await put(app, headers, { height_cm: 90, weight_kg: 20, target_weight_kg: 400 })).statusCode,
    ).toBe(200);
  });

  it('accepts any real birth date from 1900 to today, with no minimum age', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const { headers } = await guestWith(deps);
    const today = new Date().toISOString().slice(0, 10);

    for (const birth_date of ['1900-01-01', '1998-03-14', '2024-01-01', today]) {
      expect((await put(app, headers, { birth_date })).statusCode).toBe(200);
    }
  });

  it('refuses a birth date before 1900 or in the future', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const { headers } = await guestWith(deps);

    for (const birth_date of ['1899-12-31', '2999-01-01']) {
      const response = await put(app, headers, { birth_date });
      expect(response.statusCode).toBe(422);
      const { error } = response.json<ErrorBody>();
      expect(error.code).toBe('validation_failed');
      expect(error.details[0]).toMatchObject({ field: 'birth_date', code: 'out_of_range' });
    }
  });

  describe('missing_fields and completed_at', () => {
    const everyRequired = {
      sex: 'female',
      workout_frequency: '3_5',
      birth_date: '1998-03-14',
      unit_system: 'metric',
      height_cm: 170.2,
      weight_kg: 72.6,
      target_weight_kg: 65,
      goal: 'lose',
    };

    async function setup() {
      const deps = fakeDeps();
      return { app: buildApp(deps), ...(await guestWith(deps)) };
    }

    it('lists all eight in screen order for a new guest', async () => {
      const { app, headers } = await setup();
      const body = (await put(app, headers, {})).json<AnswersBody>();
      expect(body['missing_fields']).toEqual([
        'sex',
        'workout_frequency',
        'birth_date',
        'unit_system',
        'height_cm',
        'weight_kg',
        'target_weight_kg',
        'goal',
      ]);
      expect(body['completed_at']).toBeNull();
    });

    it('shrinks as screens are saved, using the API names', async () => {
      const { app, headers } = await setup();
      await put(app, headers, { sex: 'female', height_cm: 170.2 });
      const body = (await put(app, headers, { goal: 'lose' })).json<AnswersBody>();
      expect(body['missing_fields']).toEqual([
        'workout_frequency',
        'birth_date',
        'unit_system',
        'weight_kg',
        'target_weight_kg',
      ]);
    });

    it('is empty and sets completed_at when the last required answer arrives', async () => {
      const { app, headers } = await setup();
      const { goal, ...allButGoal } = everyRequired;
      const before = (await put(app, headers, allButGoal)).json<AnswersBody>();
      expect(before['missing_fields']).toEqual(['goal']);
      expect(before['completed_at']).toBeNull();

      const after = (await put(app, headers, { goal })).json<AnswersBody>();
      expect(after['missing_fields']).toEqual([]);
      expect(typeof after['completed_at']).toBe('string');
    });

    it('does not need the optional answers, and keeps the first completed_at', async () => {
      const { app, headers } = await setup();
      const first = (await put(app, headers, everyRequired)).json<AnswersBody>();
      expect(first['missing_fields']).toEqual([]);
      expect(first['obstacle']).toBeNull();

      const second = (await put(app, headers, { obstacle: 'consistency' })).json<AnswersBody>();
      expect(second['completed_at']).toBe(first['completed_at']);
    });

    it('returns the same missing_fields on a plain read as on the last save', async () => {
      const { app, headers } = await setup();
      await put(app, headers, everyRequired);
      const read = (await put(app, headers, {})).json<AnswersBody>();
      expect(read['missing_fields']).toEqual([]);
    });
  });

  describe('target weight consistency', () => {
    async function setup() {
      const deps = fakeDeps();
      const app = buildApp(deps);
      const { headers } = await guestWith(deps);
      return { app, headers };
    }

    it('refuses a goal that contradicts weights saved earlier, whichever screen comes last', async () => {
      // The real order: weight and target come before the goal screen.
      const a = await setup();
      await put(a.app, a.headers, { weight_kg: 72.6, target_weight_kg: 80 });
      const r1 = await put(a.app, a.headers, { goal: 'lose' });
      expect(r1.statusCode).toBe(422);
      expect(r1.json<ErrorBody>().error.code).toBe('target_weight_inconsistent');
      expect(r1.json<ErrorBody>().error.details[0]).toMatchObject({ field: 'target_weight_kg' });

      // And the other direction: goal first, then a contradicting target.
      const b = await setup();
      await put(b.app, b.headers, { weight_kg: 72.6, goal: 'gain' });
      const r2 = await put(b.app, b.headers, { target_weight_kg: 65 });
      expect(r2.statusCode).toBe(422);
      expect(r2.json<ErrorBody>().error.code).toBe('target_weight_inconsistent');
    });

    it('accepts a consistent set, and a change of mind that is still consistent', async () => {
      const { app, headers } = await setup();
      await put(app, headers, { weight_kg: 72.6, target_weight_kg: 65 });
      expect((await put(app, headers, { goal: 'lose' })).statusCode).toBe(200);
      // Raising the target while still below the current weight is fine.
      expect((await put(app, headers, { target_weight_kg: 70 })).statusCode).toBe(200);
      // Changing weight and goal together is judged on the result: a goal of
      // gain at 60 kg with a target of 70 kg is consistent, although the same
      // weight alone (goal still lose) would not be.
      expect((await put(app, headers, { weight_kg: 60 })).statusCode).toBe(422);
      expect((await put(app, headers, { weight_kg: 60, goal: 'gain' })).statusCode).toBe(200);
    });

    it('does not save anything from a refused request', async () => {
      const { app, headers } = await setup();
      await put(app, headers, { weight_kg: 72.6, target_weight_kg: 80 });
      const refused = await put(app, headers, { goal: 'lose', obstacle: 'support' });
      expect(refused.statusCode).toBe(422);

      const stored = (await put(app, headers, {})).json<AnswersBody>();
      expect(stored['goal']).toBeNull();
      expect(stored['obstacle']).toBeNull();
    });

    it('requires the same weight for maintain, comparing at the stored precision', async () => {
      const { app, headers } = await setup();
      await put(app, headers, { weight_kg: 60, goal: 'maintain' });
      expect((await put(app, headers, { target_weight_kg: 65 })).statusCode).toBe(422);
      // 60.04 is stored as 60.0, so it is the same weight.
      expect((await put(app, headers, { target_weight_kg: 60.04 })).statusCode).toBe(200);
    });

    it('does not block an unrelated screen because of an older inconsistency', async () => {
      const deps = fakeDeps();
      const app = buildApp(deps);
      const { guestSession, headers } = await guestWith(deps);
      // Put an inconsistent row in place directly, as if rules had changed.
      await deps.onboarding.save(
        { guestSessionId: guestSession.id },
        { weightKg: 60, targetWeightKg: 70, goal: 'lose' },
        new Date(),
      );
      expect((await put(app, headers, { obstacle: 'consistency' })).statusCode).toBe(200);
    });

    it('applies to a signed-in user the same way', async () => {
      const deps = fakeDeps();
      const app = buildApp(deps);
      const token = await deps.accessTokens.issue({ userId: 'user-2', sessionId: 'session-2' });
      const headers = { authorization: `Bearer ${token}` };
      await put(app, headers, { weight_kg: 70, target_weight_kg: 75 });
      const response = await put(app, headers, { goal: 'lose' });
      expect(response.json<ErrorBody>().error.code).toBe('target_weight_inconsistent');
    });
  });
});
