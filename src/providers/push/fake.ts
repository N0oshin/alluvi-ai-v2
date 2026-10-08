// The fake push provider: records every message. A token that starts with
// "invalid-" is reported as invalid, so the token clean-up path can be tested.

import type { PushMessage, PushProvider } from './types.js';

export interface FakePush extends PushProvider {
  readonly sent: PushMessage[];
}

export function fakePush(): FakePush {
  const sent: PushMessage[] = [];

  return {
    sent,
    send(message) {
      if (message.token.startsWith('invalid-')) {
        return Promise.resolve({ status: 'invalid_token' });
      }
      sent.push(message);
      return Promise.resolve({ status: 'sent' });
    },
  };
}
