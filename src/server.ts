// API process entry point: builds the app and starts listening.

// Importing config validates the environment first. If a variable is missing
// or invalid, this import throws and the process exits before anything starts.
import pino from 'pino';
import { config } from './config/index.js';
import { buildApp } from './app.js';
import { createIdempotencyStore } from './db/idempotency-store.js';
import { checkDatabase, db, pool } from './db/index.js';
import { createRateLimitStore } from './db/rate-limit-store.js';
import { jobs } from './jobs/definitions.js';
import { createPgBoss } from './jobs/runner.js';
import { buildProviders } from './providers/index.js';
import { usingEphemeralAccessTokenKey } from './shared/auth/access-token.js';
import { loggerOptions } from './shared/http/logging.js';

const logger = loggerOptions({
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});

// A Pino logger for the pieces that start before the app exists.
const log = pino(logger);

if (usingEphemeralAccessTokenKey) {
  log.warn(
    'ACCESS_TOKEN_KEYS is not set; using a key generated at start-up, so every access token expires at restart',
  );
}

const providers = buildProviders(config);
if (providers.identityTokens.apple === undefined)
  log.warn('APPLE_CLIENT_IDS is not set; POST /v1/auth/apple answers 503');
if (providers.identityTokens.google === undefined)
  log.warn('GOOGLE_CLIENT_IDS is not set; POST /v1/auth/google answers 503');

// The job queue, in enqueue-only mode: no handlers, so this process never
// runs a job. The worker process (src/worker.ts) does that.
const queue = createPgBoss({
  connectionString: config.DATABASE_URL,
  jobs,
  log,
  instanceName: 'api',
});
await queue.start();

const app = buildApp(
  {
    checkDatabase,
    idempotencyStore: createIdempotencyStore(db),
    rateLimitStore: createRateLimitStore(db),
    jobs: queue.queue,
    providers,
    appLinks: {
      appleTeamId: config.APPLE_TEAM_ID,
      iosBundleId: config.IOS_BUNDLE_ID ?? config.APPLE_CLIENT_IDS?.[0],
      androidPackageName: config.ANDROID_PACKAGE_NAME,
      androidCertSha256: config.ANDROID_CERT_SHA256,
      // Group invite links (document 02 section 12.9).
      linkPath: '/groups/',
    },
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
