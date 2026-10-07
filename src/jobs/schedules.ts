// The cron schedules: which jobs run on a clock, and when. The worker
// registers these in pg-boss at start and removes any it no longer finds
// here. Times are UTC.
//
//   minute hour day month weekday
//   0      3    *   *     *        every day at 03:00
//   */5    *    *   *     *        every five minutes
//   *      *    *   *     *        every minute

import type { JobPayloads } from './definitions.js';
import type { JobSchedules } from './queue.js';

export const schedules: JobSchedules<JobPayloads> = {
  // Expired idempotency keys and rate limit windows, once a night.
  'infrastructure.cleanup': { cron: '0 3 * * *', payload: {} },
  // The outbox is drained every minute. A route may also enqueue
  // 'outbox.publish' right after a commit so its event goes out sooner.
  'outbox.publish': { cron: '* * * * *', payload: {} },
};
