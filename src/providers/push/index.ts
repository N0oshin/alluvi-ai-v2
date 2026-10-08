// Picks the push provider from PUSH_PROVIDER.
//
//   fake   kept in memory (tests and local development)
//   fcm    Firebase Cloud Messaging (Phase 10.2)

import type { Config } from '../../config/index.js';
import { notImplemented, selectProvider } from '../factory.js';
import { fakePush } from './fake.js';
import type { PushProvider } from './types.js';

export function buildPushProvider(config: Config): PushProvider {
  return selectProvider('PUSH_PROVIDER', config.PUSH_PROVIDER, {
    fake: () => fakePush(),
    fcm: notImplemented('PUSH_PROVIDER=fcm', 'Phase 10.2'),
  });
}

export * from './types.js';
export { fakePush, type FakePush } from './fake.js';
