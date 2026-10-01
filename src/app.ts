// Builds the application without starting a network listener, so tests can
// construct it in-process. Fastify is wired in here in Phase 1.3; until then
// this returns a minimal object with the same lifecycle shape.

export interface App {
  start(port: number): Promise<void>;
  stop(): Promise<void>;
}

export function buildApp(): App {
  return {
    start(port) {
      console.log(`alluvi-backend skeleton ready (port ${port}); HTTP server arrives in Phase 1.3`);
      return Promise.resolve();
    },
    stop() {
      // nothing to release yet
      return Promise.resolve();
    },
  };
}
