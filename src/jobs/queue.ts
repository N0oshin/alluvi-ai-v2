// this file holds the shapes, with no real jobs in it. It says what a job setting looks like, what a queue can do, what a handler looks like, what a handler receives. Everything is generic over some P that is not named.

export interface JobSettings {
  retryLimit: number;
  retryDelaySeconds: number;
  retryBackoff: boolean;
  expireInSeconds: number;
  policy: 'standard' | 'short';
}

// One JobSettings per job name. `{ [N in keyof P]: ... }` is a mapped type:
export type JobCatalogue<P> = { readonly [N in keyof P]: JobSettings };

export interface EnqueueOptions {
  // Do not run before this instant.
  startAfter?: Date;
  singletonKey?: string;
}

export interface JobQueue<P> {
  // Adds a job. Resolves to its id, or null when a singletonKey job was
  // dropped because one is already waiting.
  enqueue<N extends keyof P & string>(
    name: N,
    payload: P[N],
    options?: EnqueueOptions,
  ): Promise<string | null>;
}

// What a handler gets besides its payload.
export interface JobContext {
  id: string;
  // 0 on the first run, 1 on the first retry, and so on.
  attempt: number;
  // Fires when the worker is shutting down; a long handler should stop early.
  signal: AbortSignal;
  log: JobLogger;
}

// The subset of a Pino logger a handler needs. Kept narrow so tests can pass
// a plain object.
export interface JobLogger {
  info(data: object, message: string): void;
  warn(data: object, message: string): void;
  error(data: object, message: string): void;
}

export type JobHandler<Payload> = (payload: Payload, context: JobContext) => Promise<void>;

export type JobHandlers<P> = { readonly [N in keyof P]: JobHandler<P[N]> };

export interface EnqueuedJob<P> {
  id: string;
  name: keyof P & string;
  payload: P[keyof P];
  options: EnqueueOptions;
}

//-------------for test------------------
// In-memory queue for tests: records what was enqueued and runs nothing.
// A test asserts on `.jobs`, or calls `.run(handlers)` to execute them.
export interface MemoryJobQueue<P> extends JobQueue<P> {
  readonly jobs: EnqueuedJob<P>[];
  clear(): void;
}

export function memoryJobQueue<P>(): MemoryJobQueue<P> {
  const jobs: EnqueuedJob<P>[] = [];
  let next = 1;

  return {
    jobs,
    enqueue(name, payload, options = {}) {
      const { singletonKey } = options;
      if (
        singletonKey !== undefined &&
        jobs.some((job) => job.name === name && job.options.singletonKey === singletonKey)
      ) {
        return Promise.resolve(null);
      }
      const id = `job-${next}`;
      next += 1;
      jobs.push({ id, name, payload, options });
      return Promise.resolve(id);
    },
    clear() {
      jobs.length = 0;
    },
  };
}

// A schedule runs one job kind on a cron expression. At most one schedule
// per job in v1, so the table is keyed by job name; a job without an entry
// is never scheduled.
export interface ScheduleSpec<Payload> {
  cron: string;
  payload: Payload;
}

export type JobSchedules<P> = { readonly [N in keyof P]?: ScheduleSpec<P[N]> };
