// Picks the email provider from EMAIL_PROVIDER.
//
//   fake     kept in memory (tests and local development)
//   resend   Resend API (Phase 2.3); needs RESEND_API_KEY and EMAIL_FROM

import type { Config } from '../../config/index.js';
import { selectProvider } from '../factory.js';
import { fakeEmail } from './fake.js';
import { resendEmail } from './resend.js';
import type { EmailProvider } from './types.js';

export function buildEmailProvider(config: Config): EmailProvider {
  return selectProvider('EMAIL_PROVIDER', config.EMAIL_PROVIDER, {
    fake: () => fakeEmail(),
    resend: () => {
      // The config check guarantees both when EMAIL_PROVIDER=resend; this
      // is for the type checker, which cannot see that rule.
      if (config.RESEND_API_KEY === undefined || config.EMAIL_FROM === undefined) {
        throw new Error('EMAIL_PROVIDER=resend needs RESEND_API_KEY and EMAIL_FROM');
      }
      return resendEmail({ apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM });
    },
  });
}

export * from './types.js';
export { fakeEmail, type FakeEmail } from './fake.js';
export { resendEmail, ResendError, type ResendOptions } from './resend.js';
