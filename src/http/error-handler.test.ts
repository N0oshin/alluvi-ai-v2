import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { AppError } from './errors.js';

const deps = { checkDatabase: () => Promise.resolve() };

// The shape of the JSON body, so the tests can read its fields with types.
interface ErrorBody {
  error: { code: string; message: string; request_id: string; details: unknown[] };
}

describe('error envelope', () => {
  it('wraps an unknown URL as not_found, with the request id', async () => {
    const app = buildApp(deps);

    const response = await app.inject({ method: 'GET', url: '/no-such-route' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'not_found',
        message: 'The resource was not found.',
        request_id: response.headers['x-request-id'],
        details: [],
      },
    });
    await app.close();
  });

  it('sends an AppError with the status of its code', async () => {
    const app = buildApp(deps);
    app.get('/forbidden', () => {
      throw new AppError('forbidden');
    });

    const response = await app.inject({ method: 'GET', url: '/forbidden' });

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('forbidden');
    await app.close();
  });

  it('includes the details of an AppError', async () => {
    const app = buildApp(deps);
    const detail = { field: 'weight_kg', code: 'out_of_range', message: 'Must be 20 to 400.' };
    app.get('/invalid', () => {
      throw new AppError('validation_failed', [detail]);
    });

    const response = await app.inject({ method: 'GET', url: '/invalid' });

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details).toEqual([detail]);
    await app.close();
  });

  it('hides the message of an unexpected error', async () => {
    // What gets logged instead is covered in logging.test.ts.
    const app = buildApp(deps);
    app.get('/bug', () => {
      throw new Error('password is hunter2');
    });

    const response = await app.inject({ method: 'GET', url: '/bug' });

    expect(response.statusCode).toBe(500);
    expect(response.json<ErrorBody>().error.code).toBe('internal_error');
    expect(response.body).not.toContain('hunter2');
    await app.close();
  });

  it('answers malformed_request for a body that is not valid JSON', async () => {
    const app = buildApp(deps);
    app.post('/echo', (request) => request.body);

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('malformed_request');
    await app.close();
  });

  it('answers unsupported_media_type for a body that is not JSON at all', async () => {
    const app = buildApp(deps);
    app.post('/echo', (request) => request.body);

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json<ErrorBody>().error.code).toBe('unsupported_media_type');
    await app.close();
  });
});
