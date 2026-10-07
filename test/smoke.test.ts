import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { memoryIdempotencyStore } from '../src/http/idempotency.js';

// A fake database check that always succeeds, so no real database is needed.
const deps = { checkDatabase: () => Promise.resolve(), idempotencyStore: memoryIdempotencyStore() };

// app.inject() sends a request straight into the app, without opening a port.
describe('app skeleton', () => {
  it('answers a route under /v1', async () => {
    const app = buildApp(deps);

    const response = await app.inject({ method: 'GET', url: '/v1/ping' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pong: true });
    await app.close();
  });

  it('does not answer the same route without the /v1 prefix', async () => {
    const app = buildApp(deps);

    const response = await app.inject({ method: 'GET', url: '/ping' });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
