import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeDeps } from '../../test/app-deps.js';
import { buildApp } from '../app.js';
import type { ErrorDetail } from './errors.js';
import { validate } from './validate.js';

const deps = fakeDeps();

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

// A sample schema, shaped like a real request body.
const schema = z.strictObject({
  weight_kg: z.number().min(20).max(400),
  note: z.string().optional(),
  device: z.strictObject({ platform: z.enum(['ios', 'android']) }).optional(),
});

// Builds the app with one route that validates its body with the schema.
function buildTestApp() {
  const app = buildApp(deps);
  app.post('/weights', (request) => {
    const body = validate(schema, request.body);
    return { saved_kg: body.weight_kg };
  });
  return app;
}

// Sends a body to the route and returns the status and the parsed response.
async function post(payload: object) {
  const app = buildTestApp();
  const response = await app.inject({ method: 'POST', url: '/weights', payload });
  await app.close();
  return response;
}

describe('validate', () => {
  it('lets valid input through', async () => {
    const response = await post({ weight_kg: 72.5, note: 'morning' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ saved_kg: 72.5 });
  });

  it('rejects an unknown field', async () => {
    const response = await post({ weight_kg: 72.5, wieght_kg: 80 });

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.code).toBe('validation_failed');
    expect(response.json<ErrorBody>().error.details).toEqual([
      { field: 'wieght_kg', code: 'unknown_field', message: 'This field is not allowed.' },
    ]);
  });

  it('rejects an unknown field inside a nested object', async () => {
    const response = await post({ weight_kg: 72.5, device: { platform: 'ios', model: 'x' } });

    expect(response.json<ErrorBody>().error.details).toEqual([
      { field: 'device.model', code: 'unknown_field', message: 'This field is not allowed.' },
    ]);
  });

  it('reports a value outside its range', async () => {
    const response = await post({ weight_kg: 5 });

    const details = response.json<ErrorBody>().error.details;
    expect(response.statusCode).toBe(422);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ field: 'weight_kg', code: 'out_of_range' });
  });

  it('reports a missing required field', async () => {
    const response = await post({ note: 'no weight' });

    expect(response.json<ErrorBody>().error.details).toEqual([
      { field: 'weight_kg', code: 'required', message: 'This field is required.' },
    ]);
  });

  it('reports a value of the wrong type', async () => {
    const response = await post({ weight_kg: 'heavy' });

    const details = response.json<ErrorBody>().error.details;
    expect(details[0]).toMatchObject({ field: 'weight_kg', code: 'invalid_type' });
  });

  it('reports every problem at once', async () => {
    const response = await post({ weight_kg: 900, note: 5, extra: true });

    const codes = response.json<ErrorBody>().error.details.map((detail) => detail.code);
    expect(codes.sort()).toEqual(['invalid_type', 'out_of_range', 'unknown_field']);
  });
});
