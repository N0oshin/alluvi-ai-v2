// The fake email provider: keeps every message in memory so a test can read
// the magic link out of it.

import type { EmailMessage, EmailProvider } from './types.js';

export interface FakeEmail extends EmailProvider {
  readonly sent: EmailMessage[];
  // Makes the next send throw, to test the retry path.
  failNextWith?: Error | undefined;
}

export function fakeEmail(): FakeEmail {
  const sent: EmailMessage[] = [];
  let next = 1;

  return {
    sent,
    send(message) {
      if (this.failNextWith !== undefined) {
        const error = this.failNextWith;
        this.failNextWith = undefined;
        return Promise.reject(error);
      }
      sent.push(message);
      const messageId = `fake-email-${next}`;
      next += 1;
      return Promise.resolve({ messageId });
    },
  };
}
