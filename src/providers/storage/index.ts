// Picks the storage provider from STORAGE_PROVIDER.
//
//   fake   kept in memory (tests and local development)
//   s3     AWS S3 with pre-signed URLs (next Phase 1.5 item)

import type { Config } from '../../config/index.js';
import { notImplemented, selectProvider } from '../factory.js';
import { fakeStorage } from './fake.js';
import type { StorageProvider } from './types.js';

export function buildStorageProvider(config: Config): StorageProvider {
  return selectProvider('STORAGE_PROVIDER', config.STORAGE_PROVIDER, {
    fake: () => fakeStorage(),
    s3: notImplemented('STORAGE_PROVIDER=s3', 'Phase 1.5, S3 client item'),
  });
}

export * from './types.js';
export { fakeStorage, type FakeStorage } from './fake.js';
