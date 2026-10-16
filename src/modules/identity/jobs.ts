// identity.purge: the nightly sweep of identity rows that can never be used
// again.
//
//   magic links       expired. A link lives 15 minutes, but is kept a day
//                     longer so a person who taps an old email is told "this
//                     link has expired" (410) and not "not valid" (401).
//   guest sessions    expired and never claimed: someone opened the app,
//                     answered some onboarding questions, and never signed
//                     up. Their onboarding answers go with the session.

import type { JobPayloads } from '../../jobs/definitions.js';
import type { JobHandlers } from '../../jobs/queue.js';
import { DAY } from '../../shared/http/rate-limit.js';
import { deleteExpiredGuestSessions, deleteExpiredMagicLinks } from './queries.js';

// How long an expired magic link is kept before the purge removes it.
export const MAGIC_LINK_RETENTION_MS = DAY;

export const identityJobs: Pick<JobHandlers<JobPayloads>, 'identity.purge'> = {
  'identity.purge': async (payload, context) => {
    // `before` in the payload pins the clock for tests; otherwise now.
    const now = payload.before === undefined ? new Date() : new Date(payload.before);

    const magicLinks = await deleteExpiredMagicLinks(
      new Date(now.getTime() - MAGIC_LINK_RETENTION_MS),
    );
    const guestSessions = await deleteExpiredGuestSessions(now);

    context.log.info({ magicLinks, guestSessions }, 'expired identity rows deleted');
  },
};
