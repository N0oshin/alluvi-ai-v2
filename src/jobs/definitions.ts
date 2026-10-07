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
};
