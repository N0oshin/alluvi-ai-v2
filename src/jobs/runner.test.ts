// Runs pg-boss against the test database. pg-boss keeps its own tables in
// the `pgboss` schema, outside the application tables that truncateAll
// empties, so each test clears the queues it uses itself.

import { afterEach, expect, it, vi } from 'vitest';
import { config } from '../config/index.js';
import { describeWithDatabase } from '../../test/db.js';
import type { JobCatalogue, JobHandlers, JobLogger, JobSchedules } from './queue.js';
import { createPgBoss, DEAD_LETTER_QUEUE, type PgBossRunner } from './runner.js';

interface TestPayloads {
  'test.echo': { value: string };
  'test.explode': { reason: string };
}

// Fast retries so the dead letter path runs in seconds.
const catalogue: JobCatalogue<TestPayloads> = {
  'test.echo': {
    retryLimit: 0,
    retryDelaySeconds: 0,
    retryBackoff: false,
    expireInSeconds: 60,
    policy: 'short',
  },
  'test.explode': {
    retryLimit: 1,
    retryDelaySeconds: 0,
    retryBackoff: false,
    expireInSeconds: 60,
    policy: 'standard',
  },
};

const silent: JobLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function build(
  handlers?: JobHandlers<TestPayloads>,
  schedules?: JobSchedules<TestPayloads>,
): PgBossRunner<TestPayloads> {
  return createPgBoss({
    connectionString: config.TEST_DATABASE_URL ?? '',
    jobs: catalogue,
    log: silent,
    instanceName: 'test',
    pollingIntervalSeconds: 0.5,
    ...(handlers !== undefined && { handlers }),
    ...(schedules !== undefined && { schedules }),
  });
}

const noHandlers: JobHandlers<TestPayloads> = {
  'test.echo': () => Promise.resolve(),
  'test.explode': () => Promise.resolve(),
};

// Waits until `check` resolves true, polling every 100 ms, for up to `ms`.
async function waitFor(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met in time');
}

describeWithDatabase('createPgBoss', () => {
  const runners: PgBossRunner<TestPayloads>[] = [];

  // Queues keep their policy once created, so each test removes the ones it
  // made; a change to the test catalogue is then picked up next run.
  afterEach(async () => {
    for (const runner of runners.splice(0)) {
      await runner.boss.deleteAllJobs();
      for (const name of Object.keys(catalogue)) {
        await runner.boss.deleteQueue(name);
      }
      await runner.stop();
    }
  });

  it('enqueues a job and a worker runs its handler with the payload', async () => {
    const echo = vi.fn<JobHandlers<TestPayloads>['test.echo']>(() => Promise.resolve());
    const runner = build({ 'test.echo': echo, 'test.explode': () => Promise.resolve() });
    runners.push(runner);
    await runner.start();

    const id = await runner.queue.enqueue('test.echo', { value: 'hello' });

    expect(id).toEqual(expect.any(String));
    await waitFor(() => Promise.resolve(echo.mock.calls.length === 1));
    expect(echo.mock.calls[0]?.[0]).toEqual({ value: 'hello' });
    expect(echo.mock.calls[0]?.[1]).toMatchObject({ id, attempt: 0 });
  }, 30_000);

  it('retries a failing job and then moves it to the dead letter queue', async () => {
    const explode = vi.fn<JobHandlers<TestPayloads>['test.explode']>((payload) =>
      Promise.reject(new Error(payload.reason)),
    );
    const runner = build({ 'test.echo': () => Promise.resolve(), 'test.explode': explode });
    runners.push(runner);
    await runner.start();

    const id = await runner.queue.enqueue('test.explode', { reason: 'provider down' });

    // retryLimit 1: the first run plus one retry.
    await waitFor(() => Promise.resolve(explode.mock.calls.length === 2));
    expect(explode.mock.calls.map(([, context]) => context.attempt)).toEqual([0, 1]);

    await waitFor(async () => {
      const dead = await runner.boss.findJobs(DEAD_LETTER_QUEUE);
      return dead.length === 1;
    });
    const [dead] = await runner.boss.findJobs<TestPayloads['test.explode']>(DEAD_LETTER_QUEUE);
    expect(dead).toMatchObject({
      data: { reason: 'provider down' },
      sourceName: 'test.explode',
      state: 'created',
    });
    expect(dead?.sourceId).toBe(id);
  }, 30_000);

  it('enqueues without handlers and does not run anything itself', async () => {
    const api = build();
    runners.push(api);
    await api.start();

    const id = await api.queue.enqueue('test.echo', { value: 'later' });

    expect(id).toEqual(expect.any(String));
    const [job] = await api.boss.findJobs('test.echo', { id: id ?? '' });
    expect(job?.state).toBe('created');
  }, 30_000);

  it('registers the schedules from the table and removes the ones that are gone', async () => {
    const scheduled = build(noHandlers, {
      'test.echo': { cron: '0 3 * * *', payload: { value: 'nightly' } },
    });
    runners.push(scheduled);
    await scheduled.start();

    const after = await scheduled.boss.getSchedules();
    expect(after.map((s) => [s.name, s.cron, s.timezone, s.data])).toEqual([
      ['test.echo', '0 3 * * *', 'UTC', { value: 'nightly' }],
    ]);

    // A second start with no schedules for this catalogue unschedules it.
    await scheduled.stop();
    runners.pop();
    const bare = build(noHandlers, {});
    runners.push(bare);
    await bare.start();

    expect(await bare.boss.getSchedules()).toEqual([]);
  }, 30_000);

  it('keeps one waiting job per singleton key', async () => {
    const api = build();
    runners.push(api);
    await api.start();

    const first = await api.queue.enqueue('test.echo', { value: 'a' }, { singletonKey: 'k' });
    const second = await api.queue.enqueue('test.echo', { value: 'b' }, { singletonKey: 'k' });

    expect(first).toEqual(expect.any(String));
    expect(second).toBeNull();
  }, 30_000);
});
