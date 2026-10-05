// Builds the application without starting a network listener

import Fastify, { type FastifyInstance } from 'fastify';
import { addErrorHandling } from './http/error-handler.js';
import { addRequestIdHeader, generateRequestId } from './http/request-id.js';
import { healthRoutes, type HealthDependencies } from './routes/health.js';
import { v1Routes } from './routes/v1.js';

// Everything the app needs from the outside world (database, and later
// storage, email and so on).
export type AppDependencies = HealthDependencies;

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ genReqId: generateRequestId });

  addRequestIdHeader(app);

  addErrorHandling(app);

  void app.register(healthRoutes(deps), { prefix: '/health' });

  // Every route inside v1Routes gets "/v1" in front of its path.
  void app.register(v1Routes, { prefix: '/v1' });

  return app;
}
