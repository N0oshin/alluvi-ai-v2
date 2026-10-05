// Turns every failure into the error envelope of document 02 section 1.2:
//
//   { "error": { "code", "message", "request_id", "details" } }
//
// Three kinds of failure arrive here:
//   1. An AppError thrown by our own code: sent as it is.
//   2. An error raised by Fastify itself (invalid JSON, body too large,
//      wrong content type): translated to the matching code.
//   3. Anything else (a bug, a database failure): sent as internal_error.
//      The real message is logged, never sent, so nothing internal leaks.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { AppError, ERROR_CODES, type ErrorCode } from './errors.js';

// A thrown value can be anything, so its type is `unknown`. This reads its
// `statusCode` if it has a numeric one. See docs/typescript-notes.md entry 20.
function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    return typeof error.statusCode === 'number' ? error.statusCode : undefined;
  }
  return undefined;
}

// Fastify's own errors carry an HTTP status. This picks our code for it.
function codeForStatus(statusCode: number | undefined): ErrorCode {
  switch (statusCode) {
    case 400:
      return 'malformed_request';
    case 404:
      return 'not_found';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    default:
      return 'internal_error';
  }
}

function sendError(reply: FastifyReply, requestId: string, error: AppError) {
  return reply.code(ERROR_CODES[error.code].status).send({
    error: {
      code: error.code,
      message: error.message,
      request_id: requestId,
      details: error.details,
    },
  });
}

export function addErrorHandling(app: FastifyInstance): void {
  // Called when no route matches the URL.
  app.setNotFoundHandler((request, reply) => {
    return sendError(reply, request.id, new AppError('not_found'));
  });

  // Called when a route handler or a hook throws.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return sendError(reply, request.id, error);
    }

    const code = codeForStatus(statusOf(error));
    if (code === 'internal_error') {
      // Replaced by structured logging later in Phase 1.3.
      console.error(`request ${request.id} failed:`, error);
    }
    return sendError(reply, request.id, new AppError(code));
  });
}
