// Picks the email provider from EMAIL_PROVIDER.
//
//   fake     kept in memory (tests and local development)
//   resend   Resend API (Phase 2.3)

import type { Config } from '../../config/index.js';
import { notImplemented, selectProvider } from '../factory.js';
import { fakeEmail } from './fake.js';
import type { EmailProvider } from './types.js';

export function buildEmailProvider(config: Config): EmailProvider {
  return selectProvider('EMAIL_PROVIDER', config.EMAIL_PROVIDER, {
    fake: () => fakeEmail(),
    resend: notImplemented('EMAIL_PROVIDER=resend', 'Phase 2.3'),
  });
}

export * from './types.js';
export { fakeEmail, type FakeEmail } from './fake.js';
