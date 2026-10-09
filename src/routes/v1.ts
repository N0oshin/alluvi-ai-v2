// Every route of API version 1. app.ts registers this file with the prefix
// "/v1", so a route written here as "/ping" is reached at "/v1/ping".
//
// Like healthRoutes, this is a function that takes the dependencies and
// returns the plugin, so each module's routes can be handed the stores and
// services they need. Modules are added here in their phase.

import type { FastifyPluginCallback } from 'fastify';
import type { AppDependencies } from '../app.js';
import { guestSessionRoutes } from '../modules/identity/guest-sessions.js';
import { sessionRoutes } from '../modules/identity/sessions.js';

export function v1Routes(deps: AppDependencies): FastifyPluginCallback {
  return (app, _options, done) => {
    // A minimal route that proves the /v1 prefix works. A handler returns a
    // plain object and Fastify sends it as JSON.
    app.get('/ping', () => {
      return { pong: true };
    });

    void app.register(guestSessionRoutes(deps));
    void app.register(sessionRoutes(deps));

    done();
  };
}
