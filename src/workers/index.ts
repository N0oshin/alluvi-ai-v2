// Worker process entry point: runs the background jobs. Started separately
// from the API (`npm run worker`), against the same database. Both can run
// on one machine in development; in production they are separate processes
// so a slow job never delays an HTTP response.

import pino from 'pino';
import { config } from '../config/index.js';
import { createIdempotencyStore } from '../db/idempotency-store.js';
import { db, pool } from '../db/index.js';
import { createRateLimitStore } from '../db/rate-limit-store.js';
import { loggerOptions } from '../http/logging.js';
import { jobs } from '../jobs/definitions.js';
import { buildHandlers } from '../jobs/handlers/index.js';
import { createPgBoss } from '../jobs/runner.js';

const log = pino(
  loggerOptions({ level: config.LOG_LEVEL, pretty: config.NODE_ENV === 'development' }),
);

const runner = createPgBoss({
  connectionString: config.DATABASE_URL,
  jobs,
  handlers: buildHandlers({
    idempotencyStore: createIdempotencyStore(db),
    rateLimitStore: createRateLimitStore(db),
  }),
  log,
  instanceName: 'worker',
});

await runner.start();
log.info({ jobs: Object.keys(jobs) }, 'alluvi-worker running');

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  // Finishes the job in hand, stops taking new ones, closes pg-boss's connections.
  await runner.stop();
  await pool.end();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
