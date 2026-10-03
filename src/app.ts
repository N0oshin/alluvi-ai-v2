// Builds the application without starting a network listener, so tests can
// construct it in-process and send it requests with app.inject().
// server.ts is the only file that opens a port.

import Fastify, { type FastifyInstance } from 'fastify';
import { healthRoutes, type HealthDependencies } from './routes/health.js';
import { v1Routes } from './routes/v1.js';

// Everything the app needs from the outside world (database, and later
// storage, email and so on). server.ts passes the real things; tests pass
// fakes, so they never touch a real database.
export type AppDependencies = HealthDependencies;

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify();

  // `void` is explained in docs/typescript-notes.md entry 9.
  void app.register(healthRoutes(deps), { prefix: '/health' });

  // Every route inside v1Routes gets "/v1" in front of its path.
  void app.register(v1Routes, { prefix: '/v1' });

  return app;
}
