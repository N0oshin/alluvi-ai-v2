// Health endpoints. They are not part of the API the phone uses, so they sit
// at /health, outside /v1. The process manager and monitoring call them.
//
//   GET /health/live   "is the process running?"  Always 200 while it is up.
//   GET /health/ready  "can it serve requests?"   200 only if the database
//                      answers; 503 if it does not.

import type { FastifyPluginCallback } from 'fastify';

// What these routes need from outside. app.ts passes the real database check;
// tests pass a fake one. See docs/typescript-notes.md entry 17.
export interface HealthDependencies {
  // Resolves when the database answers; rejects when it cannot be reached.
  checkDatabase: () => Promise<void>;
}

// A function that returns the plugin, so the plugin can use `deps`.
export function healthRoutes(deps: HealthDependencies): FastifyPluginCallback {
  return (app, _options, done) => {
    app.get('/live', () => {
      return { status: 'ok' };
    });

    app.get('/ready', async (_request, reply) => {
      try {
        await deps.checkDatabase();
        return { status: 'ok', checks: { database: 'ok' } };
      } catch {
        // 503 Service Unavailable: the process is up but cannot do its job.
        return reply.code(503).send({ status: 'unavailable', checks: { database: 'failed' } });
      }
    });

    done();
  };
}
