// Process entry point: builds the app and starts listening.

// Importing config validates the environment first. If a variable is missing
// or invalid, this import throws and the process exits before anything starts.
import { config } from './config/index.js';
import { buildApp } from './app.js';
import { createIdempotencyStore } from './db/idempotency-store.js';
import { checkDatabase, db, pool } from './db/index.js';
import { createRateLimitStore } from './db/rate-limit-store.js';
import { loggerOptions } from './http/logging.js';

const app = buildApp(
  {
    checkDatabase,
    idempotencyStore: createIdempotencyStore(db),
    rateLimitStore: createRateLimitStore(db),
  },
  { logger: loggerOptions({ level: config.LOG_LEVEL, pretty: config.NODE_ENV === 'development' }) },
);

await app.listen({ port: config.PORT });
app.log.info({ port: config.PORT }, 'alluvi-backend listening');

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  // Stops accepting new requests and waits for the running ones to finish.
  await app.close();
  // Closes the database connections so the process can exit.
  await pool.end();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
