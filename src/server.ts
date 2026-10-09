// Process entry point: builds the app and starts listening.

// Importing config validates the environment first. If a variable is missing
// or invalid, this import throws and the process exits before anything starts.
import pino from 'pino';
import { config } from './config/index.js';
import { buildApp } from './app.js';
import {
  createAccessTokenService,
  ephemeralAccessTokenService,
  type AccessTokenService,
} from './auth/access-token.js';
import { createAccountStore } from './db/account-store.js';
import { createDeviceStore } from './db/device-store.js';
import { createGuestSessionStore } from './db/guest-session-store.js';
import { createIdempotencyStore } from './db/idempotency-store.js';
import { checkDatabase, db, pool } from './db/index.js';
import { createRateLimitStore } from './db/rate-limit-store.js';
import { createSessionStore } from './db/session-store.js';
import { loggerOptions } from './http/logging.js';
import { jobs } from './jobs/definitions.js';
import { createPgBoss } from './jobs/runner.js';
import { buildProviders } from './providers/index.js';

const logger = loggerOptions({
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});

// A Pino logger for the pieces that start before the app exists.
const log = pino(logger);

// The job queue, in enqueue-only mode: no handlers, so this process never
// runs a job. The worker process (src/workers/index.ts) does that.
const queue = createPgBoss({
  connectionString: config.DATABASE_URL,
  jobs,
  log,
  instanceName: 'api',
});
await queue.start();

// Access token keys come from the environment. Outside production the server
// may run without them, on a key made now and forgotten at exit.
let accessTokens: AccessTokenService;
if (config.ACCESS_TOKEN_KEYS !== undefined) {
  accessTokens = createAccessTokenService(config.ACCESS_TOKEN_KEYS);
} else {
  log.warn(
    'ACCESS_TOKEN_KEYS is not set; using a key generated at start-up, so every access token expires at restart',
  );
  accessTokens = ephemeralAccessTokenService();
}

const app = buildApp(
  {
    checkDatabase,
    idempotencyStore: createIdempotencyStore(db),
    rateLimitStore: createRateLimitStore(db),
    jobs: queue.queue,
    providers: buildProviders(config),
    accessTokens,
    guestSessions: createGuestSessionStore(db),
    devices: createDeviceStore(db),
    accounts: createAccountStore(db),
    sessions: createSessionStore(db),
  },
  { logger },
);

await app.listen({ port: config.PORT });
app.log.info({ port: config.PORT }, 'alluvi-backend listening');

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  // Stops accepting new requests and waits for the running ones to finish.
  await app.close();
  // Closes the queue's and the database's connections so the process can exit.
  await queue.stop();
  await pool.end();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
