// Builds the application without starting a network listener, so tests can
// construct it in-process and send it requests with app.inject().
// server.ts is the only file that opens a port.

import Fastify, { type FastifyInstance } from 'fastify';
import { addErrorHandling } from './http/error-handler.js';
import { addRequestIdHeader, generateRequestId } from './http/request-id.js';
import { healthRoutes, type HealthDependencies } from './routes/health.js';
import { v1Routes } from './routes/v1.js';

// Everything the app needs from the outside world (database, and later
// storage, email and so on). server.ts passes the real things; tests pass
// fakes, so they never touch a real database.
export type AppDependencies = HealthDependencies;

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ genReqId: generateRequestId });

  // Must come before the routes: a hook only applies to routes registered
  // after it.
  addRequestIdHeader(app);

  // Every error leaves the app in the same JSON shape.
  addErrorHandling(app);

  // `void` is explained in docs/typescript-notes.md entry 9.
  void app.register(healthRoutes(deps), { prefix: '/health' });

  // Every route inside v1Routes gets "/v1" in front of its path.
  void app.register(v1Routes, { prefix: '/v1' });

  return app;
}
