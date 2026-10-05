import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

const deps = { checkDatabase: () => Promise.resolve() };

describe('X-Request-Id', () => {
  it('is returned on a successful response', async () => {
    const app = buildApp(deps);

    const response = await app.inject({ method: 'GET', url: '/v1/ping' });

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  it('is returned when no route matches', async () => {
    const app = buildApp(deps);

    const response = await app.inject({ method: 'GET', url: '/no-such-route' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  it('is different for every request', async () => {
    const app = buildApp(deps);

    const first = await app.inject({ method: 'GET', url: '/v1/ping' });
    const second = await app.inject({ method: 'GET', url: '/v1/ping' });

    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
    await app.close();
  });

  it('ignores an id sent by the client', async () => {
    const app = buildApp(deps);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { 'x-request-id': 'chosen-by-client' },
    });

    expect(response.headers['x-request-id']).not.toBe('chosen-by-client');
    await app.close();
  });
});
