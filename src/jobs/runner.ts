//
// pg-boss keeps its queues in PostgreSQL, in its own schema `pgboss` next to
// the application tables. The worker polls the database for jobs, and when it finds one it calls the handler for that name.
//
// Retries and the dead letter queue (docs/backend-notes.md entries 2 and 31):
// when a handler throws, pg-boss runs the job again after the delay set in
// the catalogue, doubling each time if `retryBackoff` is on. After the last
// retry the job is copied to the `dead_letter` queue with its source queue
// and the last error, and stays there for a person to inspect and, once the
// cause is fixed, redrive with `boss.redrive(DEAD_LETTER_QUEUE)`.

import { PgBoss } from 'pg-boss';
import type {
  EnqueueOptions,
  JobCatalogue,
  JobHandlers,
  JobLogger,
  JobQueue,
  JobSchedules,
  JobSettings,
} from './queue.js';

export const DEAD_LETTER_QUEUE = 'dead_letter';

export interface PgBossOptions<P> {
  connectionString: string;
  jobs: JobCatalogue<P>;
  // Without handlers this process only enqueues.
  handlers?: JobHandlers<P>;
  // Cron schedules, registered by the worker on start. Only read when
  // handlers are given.
  schedules?: JobSchedules<P>;
  log: JobLogger;
  // Shown in pg-boss's instance registry: 'api' or 'worker'.
  instanceName: string;
  // How often each worker asks the database for a job, in seconds; the default of 2 is fine in production.
  pollingIntervalSeconds?: number;
}

export interface PgBossRunner<P> {
  queue: JobQueue<P>;
  // The pg-boss instance itself, for operations (redrive, inspection) and tests.
  boss: PgBoss;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// pg-boss's queue options for one catalogue entry.
function queueOptions(settings: JobSettings) {
  return {
    retryLimit: settings.retryLimit,
    retryDelay: settings.retryDelaySeconds,
    retryBackoff: settings.retryBackoff,
    expireInSeconds: settings.expireInSeconds,
    deadLetter: DEAD_LETTER_QUEUE,
  };
}

export function createPgBoss<P>(options: PgBossOptions<P>): PgBossRunner<P> {
  const { connectionString, jobs, handlers, schedules, log, instanceName, pollingIntervalSeconds } =
    options;

  const boss = new PgBoss({
    connectionString,
    instanceName,
    supervise: handlers !== undefined,
    // Likewise only the worker turns cron schedules into jobs.
    schedule: handlers !== undefined,
    // Supabase's pooler does not support LISTEN/NOTIFY; polling is the floor anyway.
    useListenNotify: false,
  });

  boss.on('error', (error) => log.error({ err: error }, 'pg-boss error'));
  boss.on('warning', (warning) => log.warn({ warning }, 'pg-boss warning'));

  //queue.enqueue: calls boss.send. This is what the API uses.
  const queue: JobQueue<P> = {
    enqueue(name, payload, enqueueOptions: EnqueueOptions = {}) {
      return boss.send(name, payload as object, {
        ...(enqueueOptions.startAfter !== undefined && { startAfter: enqueueOptions.startAfter }),
        ...(enqueueOptions.singletonKey !== undefined && {
          singletonKey: enqueueOptions.singletonKey,
        }),
      });
    },
  };

  // The catalogue's keys, typed. Object.keys returns string[], so the cast
  // tells TypeScript these are job names.
  const names = Object.keys(jobs) as (keyof P & string)[];

  async function start(): Promise<void> {
    await boss.start();

    // Queues must exist before jobs are sent to them. createQueue is a no-op
    // for an existing queue, so updateQueue follows it to keep a queue's
    // retry settings in step with the catalogue when the code changes them.
    // The dead letter queue comes first because the others point at it, and
    // its jobs are never retried: they are there to be looked at.
    await boss.createQueue(DEAD_LETTER_QUEUE, { retryLimit: 0 });
    for (const name of names) {
      const settings = queueOptions(jobs[name]);
      // The policy is fixed at creation; updateQueue does not take it.
      await boss.createQueue(name, { ...settings, policy: jobs[name].policy });
      await boss.updateQueue(name, settings);
    }

    if (handlers === undefined) {
      return;
    }

    // Schedules are upserted by job name, and a job that lost its schedule
    // in the code is unscheduled, so the database always mirrors schedules.ts.
    // 'missed: once' sends one job for a run the worker was down for.
    for (const name of names) {
      const spec = schedules?.[name];
      if (spec === undefined) {
        await boss.unschedule(name);
      } else {
        await boss.schedule(name, spec.cron, spec.payload as object, {
          tz: 'UTC',
          missed: 'once',
          singletonKey: name,
        });
      }
    }

    for (const name of names) {
      const handler = handlers[name];
      await boss.work<P[typeof name]>(
        name,
        { ...(pollingIntervalSeconds !== undefined && { pollingIntervalSeconds }) },
        // pg-boss hands over a batch of jobs; the default batch size is one.
        // A throw here fails every job in the batch, which is what triggers
        // the retry.
        async (batch) => {
          for (const job of batch) {
            const jobLog = {
              info: (data: object, message: string) =>
                log.info({ ...data, job: name, jobId: job.id }, message),
              warn: (data: object, message: string) =>
                log.warn({ ...data, job: name, jobId: job.id }, message),
              error: (data: object, message: string) =>
                log.error({ ...data, job: name, jobId: job.id }, message),
            };
            jobLog.info({ attempt: job.retryCount }, 'job started');
            try {
              await handler(job.data, {
                id: job.id,
                attempt: job.retryCount,
                signal: job.signal,
                log: jobLog,
              });
              jobLog.info({}, 'job completed');
            } catch (error) {
              jobLog.error({ err: error, attempt: job.retryCount }, 'job failed');
              throw error;
            }
          }
        },
      );
    }
  }

  async function stop(): Promise<void> {
    // Graceful: workers finish the job they hold (up to the timeout) and stop
    // taking new ones; then the connections close.
    await boss.stop({ graceful: true, timeout: 30_000, close: true });
  }

  return { queue, boss, start, stop };
}
