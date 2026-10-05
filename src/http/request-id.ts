// Request id: every request gets a unique id, and every response carries it in
// the X-Request-Id header (document 02 section 1). When a user reports a
// problem, that id finds the matching lines in the logs.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Creates the id. app.ts gives this function to Fastify, which calls it once
// per request and stores the result on `request.id`.
// An id sent by the client is ignored on purpose: the server always makes its
// own, so nobody can choose what gets written into the logs.
export function generateRequestId(): string {
  return randomUUID();
}

// Adds the response header. A hook is a function Fastify runs at a fixed
// point of every request; "onRequest" is the earliest point, so the header is
// set even when the request later fails or matches no route.
export function addRequestIdHeader(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('X-Request-Id', request.id);
    done();
  });
}
