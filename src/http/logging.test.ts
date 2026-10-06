import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loggerOptions, pathOf, REDACT_PATHS } from './logging.js';

const deps = { checkDatabase: () => Promise.resolve() };

// Builds an app whose log lines are collected in an array instead of being
// written to the terminal, so a test can read them back as objects.
function buildLoggedApp() {
  const lines: Record<string, unknown>[] = [];
  const app = buildApp(deps, {
    logger: {
      ...loggerOptions({ level: 'info', pretty: false }),
      stream: {
        write: (line: string) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    },
  });
  return { app, lines };
}

describe('pathOf', () => {
  it('removes the query string', () => {
    expect(pathOf('/v1/meals?cursor=abc&limit=5')).toBe('/v1/meals');
    expect(pathOf('/v1/meals')).toBe('/v1/meals');
  });
});

describe('request logging', () => {
  it('writes one line per request with method, path, status and the request id', async () => {
    const { app, lines } = buildLoggedApp();

    const response = await app.inject({ method: 'GET', url: '/v1/ping?secret=1' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: 'request completed',
      reqId: response.headers['x-request-id'],
      req: { method: 'GET', path: '/v1/ping' },
      res: { status: 200 },
    });
    expect(lines[0]?.responseTime).toEqual(expect.any(Number));
    expect(JSON.stringify(lines[0])).not.toContain('secret');
    await app.close();
  });

  it('does not log the liveness probe', async () => {
    const { app, lines } = buildLoggedApp();

    await app.inject({ method: 'GET', url: '/health/live' });

    expect(lines).toHaveLength(0);
    await app.close();
  });

  it('logs the error and stack of an internal failure, which the response never shows', async () => {
    const { app, lines } = buildLoggedApp();
    app.get('/boom', () => {
      throw new Error('database password is hunter2');
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('hunter2');
    const failure = lines.find((line) => line.msg === 'request failed');
    expect(failure).toMatchObject({
      reqId: response.headers['x-request-id'],
      err: { message: 'database password is hunter2' },
    });
    const { stack } = failure?.err as { stack: string };
    expect(stack).toContain('logging.test.ts');
    await app.close();
  });
});

describe('redaction', () => {
  it('covers each sensitive name at the top level and one level down', () => {
    expect(REDACT_PATHS).toContain('email');
    expect(REDACT_PATHS).toContain('*.email');
    expect(REDACT_PATHS).toContain('["set-cookie"]');
  });

  it('replaces sensitive values wherever they appear in a line', async () => {
    const { app, lines } = buildLoggedApp();
    app.get('/leak', (request) => {
      request.log.info(
        {
          email: 'ann@example.com',
          access_token: 'tok_123',
          user: { email: 'ann@example.com', id: 'u_1' },
          headers: { authorization: 'Bearer tok_123', 'set-cookie': 'sid=abc' },
        },
        'careless log call',
      );
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/leak' });

    const line = lines.find((entry) => entry.msg === 'careless log call');
    expect(line).toMatchObject({
      email: '[Redacted]',
      access_token: '[Redacted]',
      user: { email: '[Redacted]', id: 'u_1' },
      headers: { authorization: '[Redacted]', 'set-cookie': '[Redacted]' },
    });
    expect(JSON.stringify(line)).not.toContain('ann@example.com');
    expect(JSON.stringify(line)).not.toContain('tok_123');
    await app.close();
  });
});
