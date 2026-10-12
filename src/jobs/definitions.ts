// definitions.ts fills in the blanks with the real jobs. Three things:
//
// JobPayloads: the list of job names and what each one's payload contains. This is the P that gets plugged into the generic types from queue.ts.
//
// DEFAULT_JOB_SETTINGS: one JobSettings object with the retry numbers most jobs share.
//
// jobs: the catalogue, typed JobCatalogue<JobPayloads>. One settings entry per name, mostly spreading the defaults and overriding a number here and there.

import type { JobCatalogue, JobSettings } from './queue.js';

// add new jobs here, and add their payloads to JobPayloads below. The worker will pick them up automatically.
export interface JobPayloads {
  'infrastructure.cleanup': { before?: string };
  // Removes expired magic links and abandoned guest sessions.
  'identity.purge': { before?: string };
  // Builds the plan for one plan generation (Phase 3.3).
  'onboarding.generate_plan': { planGenerationId: string };
  // Hands pending outbox events to their consumers .
  'outbox.publish': { limit?: number };
}

export type JobName = keyof JobPayloads;

// Sensible for most jobs: three retries at 10s, 20s and 40s, give up after
// that (the job then lands in the dead letter queue), and treat a run that
// takes more than 5 minutes as dead.
export const DEFAULT_JOB_SETTINGS: JobSettings = {
  retryLimit: 3,
  retryDelaySeconds: 10,
  retryBackoff: true,
  expireInSeconds: 5 * 60,
  policy: 'standard',
};

export const jobs: JobCatalogue<JobPayloads> = {
  'infrastructure.cleanup': { ...DEFAULT_JOB_SETTINGS, retryLimit: 1 },
  'identity.purge': { ...DEFAULT_JOB_SETTINGS, retryLimit: 1 },
  // A generation that takes over 60 seconds counts as failed (document 03
  // section 1.4), so the run expires at 60 seconds; one retry covers a
  // transient database error.
  'onboarding.generate_plan': { ...DEFAULT_JOB_SETTINGS, retryLimit: 1, expireInSeconds: 60 },
  'outbox.publish': { ...DEFAULT_JOB_SETTINGS, retryLimit: 0, policy: 'short' },
};
