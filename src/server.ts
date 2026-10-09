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
import { APPLE, createIdentityTokenVerifier, GOOGLE } from './auth/identity-token.js';
import { createAccountStore } from './db/account-store.js';
import { createDeviceStore } from './db/device-store.js';
import { createGuestSessionStore } from './db/guest-session-store.js';
import { createIdempotencyStore } from './db/idempotency-store.js';
import { checkDatabase, db, pool } from './db/index.js';
import { createMagicLinkStore } from './db/magic-link-store.js';
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

// Apple and Google sign-in work only with their client ids configured.
const identityTokens = {
  apple: config.APPLE_CLIENT_IDS && createIdentityTokenVerifier(APPLE, config.APPLE_CLIENT_IDS),
  google: config.GOOGLE_CLIENT_IDS && createIdentityTokenVerifier(GOOGLE, config.GOOGLE_CLIENT_IDS),
};
if (identityTokens.apple === undefined)
  log.warn('APPLE_CLIENT_IDS is not set; POST /v1/auth/apple answers 503');
if (identityTokens.google === undefined)
  log.warn('GOOGLE_CLIENT_IDS is not set; POST /v1/auth/google answers 503');

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
    magicLinks: createMagicLinkStore(db),
    magicLinkBaseUrl: config.MAGIC_LINK_BASE_URL,
    identityTokens,
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
