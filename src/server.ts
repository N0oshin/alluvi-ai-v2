// Process entry point: builds the app and starts listening. Kept separate from
// app.ts so that tests never open a port.

// Importing config validates the environment first. If a variable is missing
// or invalid, this import throws and the process exits before anything starts.
import { config } from './config/index.js';
import { buildApp } from './app.js';
import { checkDatabase, pool } from './db/index.js';

// The real dependencies. `{ checkDatabase }` is short for
// `{ checkDatabase: checkDatabase }`.
const app = buildApp({ checkDatabase });

await app.listen({ port: config.PORT });
console.log(`alluvi-backend listening on port ${config.PORT}`);

const shutdown = async (signal: string) => {
  console.log(`received ${signal}, shutting down`);
  // Stops accepting new requests and waits for the running ones to finish.
  await app.close();
  // Closes the database connections so the process can exit.
  await pool.end();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
