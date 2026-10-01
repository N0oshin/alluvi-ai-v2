// Process entry point: builds the app and starts listening. Kept separate from
// app.ts so that tests never open a port.

import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 3000);
const app = buildApp();

await app.start(port);

const shutdown = async (signal: string) => {
  console.log(`received ${signal}, shutting down`);
  await app.stop();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
