import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

// Two fake database checks: one that succeeds and one that fails.
const databaseUp = { checkDatabase: () => Promise.resolve() };
const databaseDown = { checkDatabase: () => Promise.reject(new Error('connection refused')) };

describe('GET /health/live', () => {
  it('returns 200 even when the database is down', async () => {
    const app = buildApp(databaseDown);

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});

describe('GET /health/ready', () => {
  it('returns 200 when the database answers', async () => {
    const app = buildApp(databaseUp);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
    await app.close();
  });

  it('returns 503 when the database cannot be reached', async () => {
    const app = buildApp(databaseDown);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', checks: { database: 'failed' } });
    await app.close();
  });
});
