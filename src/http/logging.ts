// Structured logging. Every log line is one JSON object with named fields,
// not a sentence, so a log viewer can filter by field:
//
// Fastify ships with Pino, the standard Node.js JSON logger, and attaches the
// request id (from src/http/request-id.ts) to every line written through
// `request.log`. This file decides what goes into a line and, more
// importantly, what never does.
//
// Two layers enforce that:
//   1. The request line holds only method, path, status and timing. Bodies,
//      query strings and headers are never logged.
//   2. Pino's `redact` list scrubs known-sensitive field names from any line,
//      so a stray `request.log.info(body)` cannot leak a value.
//

import {
  LogController,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SENSITIVE_FIELDS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'guest_token',
  'email',
  'phone',
  'body',
  'text',
  'image_url',
  'photo_url',
  'upload_url',
  'download_url',
];

export const REDACT_PATHS = SENSITIVE_FIELDS.flatMap((name) => {
  // A name with a dash must be written in brackets: ["set-cookie"].
  const key = /^[a-z_]+$/.test(name) ? name : `["${name}"]`;
  return [key, `*.${key}`];
});

// The URL without its query string: `/v1/meals?cursor=abc` -> `/v1/meals`.
// Query values may carry cursors or, one day, an email; the path never does.
export function pathOf(url: string): string {
  const end = url.indexOf('?');
  return end === -1 ? url : url.slice(0, end);
}

export interface LoggerSettings {
  level: LogLevel;
  pretty: boolean;
}

// The type of Fastify's `logger` option, minus the plain `true | false` form:
// read off Fastify's own options type so it cannot drift.
export type LoggerOptions = Exclude<NonNullable<FastifyServerOptions['logger']>, boolean>;

// The options passed to Fastify's `logger` field.
export function loggerOptions(settings: LoggerSettings): LoggerOptions {
  return {
    level: settings.level,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    // Serializers decide which fields of an object are written. Replacing
    // Fastify's defaults is what keeps hostnames, remote addresses and full
    // URLs out of the log.
    serializers: {
      req: (request) => ({ method: request.method, path: pathOf(request.url ?? '') }),
      res: (reply) => ({ status: reply.statusCode }),
    },
    ...(settings.pretty ? { transport: { target: 'pino-pretty' } } : {}),
  };
}

// The liveness probe is polled every few seconds by the process manager and
// would otherwise be most of the log.
const UNLOGGED_PATHS = new Set(['/health/live']);

// Fastify writes two lines per request by default: "incoming request" (with
// `req`) and "request completed" (with `res`). This writes one line per
// request, on completion, carrying both, and skips the liveness probe.
// `override` marks a method that replaces one from the parent class
// (docs/typescript-notes.md entry 24).
export class RequestLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: (request) => UNLOGGED_PATHS.has(pathOf(request.url)) });
  }

  override incomingRequest(_request: FastifyRequest): void {
    // Intentionally silent; see requestCompleted.
  }

  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (this.isLogDisabled(request)) {
      return;
    }
    const fields = { req: request, res: reply, responseTime: reply.elapsedTime };
    if (error) {
      reply.log.error({ ...fields, err: error }, 'request errored');
    } else {
      reply.log.info(fields, 'request completed');
    }
  }
}
