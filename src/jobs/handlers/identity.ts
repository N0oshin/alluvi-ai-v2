// identity.purge: the nightly sweep of identity rows that can never be used
// again.
//
//   magic links       expired. A link lives 15 minutes, but is kept a day
//                     longer so a person who taps an old email is told "this
//                     link has expired" (410) and not "not valid" (401).
//   guest sessions    expired and never claimed: someone opened the app,
//                     answered some onboarding questions, and never signed
//                     up. Their onboarding answers go with the session.

import type { GuestSessionStore } from '../../db/guest-session-store.js';
import type { MagicLinkStore } from '../../db/magic-link-store.js';
import { DAY } from '../../shared/http/rate-limit.js';
import type { JobPayloads } from '../definitions.js';
import type { JobHandler } from '../queue.js';

export interface IdentityHandlerDependencies {
  magicLinkStore: MagicLinkStore;
  guestSessionStore: GuestSessionStore;
}

// How long an expired magic link is kept before the purge removes it.
export const MAGIC_LINK_RETENTION_MS = DAY;

export function identityPurge(
  deps: IdentityHandlerDependencies,
): JobHandler<JobPayloads['identity.purge']> {
  return async (payload, context) => {
    // `before` in the payload pins the clock for tests; otherwise now.
    const now = payload.before === undefined ? new Date() : new Date(payload.before);

    const magicLinks = await deps.magicLinkStore.deleteExpired(
      new Date(now.getTime() - MAGIC_LINK_RETENTION_MS),
    );
    const guestSessions = await deps.guestSessionStore.deleteExpired(now);

    context.log.info({ magicLinks, guestSessions }, 'expired identity rows deleted');
  };
}
