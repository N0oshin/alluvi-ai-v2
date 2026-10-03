// Every route of API version 1. app.ts registers this file with the prefix
// "/v1", so a route written here as "/ping" is reached at "/v1/ping".
// Each module (identity, food, groups, ...) adds its routes here in later
// phases.

import type { FastifyPluginCallback } from 'fastify';

// The type FastifyPluginCallback tells TypeScript what the three parameters
// are, so they need no annotations. See docs/typescript-notes.md entry 15.
export const v1Routes: FastifyPluginCallback = (app, _options, done) => {
  // A minimal route that proves the /v1 prefix works. A handler returns a
  // plain object and Fastify sends it as JSON.
  app.get('/ping', () => {
    return { pong: true };
  });

  // Tells Fastify this group of routes is fully registered.
  done();
};
