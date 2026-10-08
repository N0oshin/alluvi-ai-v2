// Barrel for the test data factories: one file per bounded context, mirroring
// src/db/schema/. Tests import from here:
//
//   import { factories } from '../factories/index.js';
//   const row = await factories.outboxEvent.create();

import * as identity from './identity.js';
import * as infrastructure from './infrastructure.js';

export const factories = {
  ...identity,
  ...infrastructure,
};

export { defineFactory, nextSequence, type Factory } from './define.js';
