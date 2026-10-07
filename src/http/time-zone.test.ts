import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app.js';
import { memoryIdempotencyStore } from './idempotency.js';
import type { ErrorDetail } from './errors.js';
import { canonicalTimeZone, localDateField, localDateIn, readTimeZone } from './time-zone.js';
import { validate } from './validate.js';

const deps = { checkDatabase: () => Promise.resolve(), idempotencyStore: memoryIdempotencyStore() };

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

// Builds the app with one route that answers the caller's zone and local date
// for a fixed instant.
function buildTestApp() {
  const app = buildApp(deps);
  app.get('/today', (request) => {
    const timeZone = readTimeZone(request.headers);
    const instant = new Date('2026-09-18T23:30:00Z');
    return { time_zone: timeZone, local_date: localDateIn(timeZone, instant) };
  });
  return app;
}

describe('canonicalTimeZone', () => {
  it('accepts IANA names and UTC', () => {
    expect(canonicalTimeZone('Europe/London')).toBe('Europe/London');
    expect(canonicalTimeZone('UTC')).toBe('UTC');
  });

  it('accepts a zone that has two names', () => {
    // Node may answer with the zone's other name ('America/Buenos_Aires'),
    // depending on its version. Both names mean the same rules.
    const timeZone = canonicalTimeZone('America/Argentina/Buenos_Aires');

    expect(timeZone).toBeDefined();
    expect(localDateIn(timeZone ?? '', new Date('2026-09-18T02:00:00Z'))).toBe('2026-09-17');
  });

  it('corrects the spelling of a known zone', () => {
    expect(canonicalTimeZone('europe/london')).toBe('Europe/London');
  });

  it('refuses unknown names, offsets and abbreviations', () => {
    expect(canonicalTimeZone('Mars/Phobos')).toBeUndefined();
    expect(canonicalTimeZone('')).toBeUndefined();
    expect(canonicalTimeZone('+01:00')).toBeUndefined();
    expect(canonicalTimeZone('EST')).toBeUndefined();
    expect(canonicalTimeZone(`Europe/${'x'.repeat(100)}`)).toBeUndefined();
  });
});

describe('localDateIn', () => {
  it('gives a different date for the same instant in different zones', () => {
    const instant = new Date('2026-09-18T23:30:00Z');

    expect(localDateIn('UTC', instant)).toBe('2026-09-18');
    expect(localDateIn('America/Los_Angeles', instant)).toBe('2026-09-18');
    // London is on summer time (UTC+1) in September: 00:30 the next day.
    expect(localDateIn('Europe/London', instant)).toBe('2026-09-19');
    expect(localDateIn('Asia/Tokyo', instant)).toBe('2026-09-19');
  });

  it('follows daylight saving', () => {
    // In December London is on UTC+0, so 23:30 UTC is still the same day.
    expect(localDateIn('Europe/London', new Date('2026-12-18T23:30:00Z'))).toBe('2026-12-18');
  });

  it('crosses month and year boundaries', () => {
    expect(localDateIn('Asia/Tokyo', new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(localDateIn('America/Los_Angeles', new Date('2026-03-01T02:00:00Z'))).toBe('2026-02-28');
  });

  it('defaults to now', () => {
    expect(localDateIn('UTC')).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('localDateField', () => {
  const schema = z.strictObject({ local_date: localDateField });

  it('accepts a real date', () => {
    expect(validate(schema, { local_date: '2026-09-18' })).toEqual({ local_date: '2026-09-18' });
  });

  it('refuses other formats and dates that do not exist', () => {
    for (const value of ['18/09/2026', '2026-9-18', '2026-02-30', '2026-09-18T10:00:00Z', '']) {
      expect(() => validate(schema, { local_date: value })).toThrow();
    }
  });
});

describe('X-Time-Zone', () => {
  it('is read from the header', async () => {
    const app = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/today',
      headers: { 'x-time-zone': 'Europe/London' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ time_zone: 'Europe/London', local_date: '2026-09-19' });
    await app.close();
  });

  it('is required', async () => {
    const app = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/today' });

    expect(response.statusCode).toBe(422);
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toEqual([
      { field: 'X-Time-Zone', code: 'required', message: 'This header is required.' },
    ]);
    await app.close();
  });

  it('must be a known zone', async () => {
    const app = buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/today',
      headers: { 'x-time-zone': 'Mars/Phobos' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details).toEqual([
      { field: 'X-Time-Zone', code: 'invalid', message: 'Must be an IANA time zone name.' },
    ]);
    await app.close();
  });
});
