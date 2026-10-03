// The real configuration, built once at start-up.
//
// This is the only place in the codebase that reads process.env. Importing
// this file loads .env (if present) and validates every variable; a missing
// or invalid variable throws here, which stops the process before it does
// anything else. Everything else imports the typed `config` object.

import dotenv from 'dotenv';
import { loadConfig } from './schema.js';

// Copies variables from .env into process.env. Variables that are already set
// (for example by the hosting platform) win over the file.
dotenv.config({ quiet: true });

export const config = loadConfig(process.env);

export { loadConfig } from './schema.js';
export type { Config } from './schema.js';
