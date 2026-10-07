import { describe, expect, it } from 'vitest';
import { memoryJobQueue } from './queue.js';

interface TestPayloads {
  'greet.user': { userId: string };
  'count.items': { amount: number };
}

describe('memoryJobQueue', () => {
  it('records each job with an id, in order', async () => {
    const queue = memoryJobQueue<TestPayloads>();

    const first = await queue.enqueue('greet.user', { userId: 'u1' });
    const second = await queue.enqueue('count.items', { amount: 3 }, { startAfter: new Date(0) });

    expect(first).toBe('job-1');
    expect(second).toBe('job-2');
    expect(queue.jobs).toEqual([
      { id: 'job-1', name: 'greet.user', payload: { userId: 'u1' }, options: {} },
      {
        id: 'job-2',
        name: 'count.items',
        payload: { amount: 3 },
        options: { startAfter: new Date(0) },
      },
    ]);
  });

  it('drops a second job with the same singleton key', async () => {
    const queue = memoryJobQueue<TestPayloads>();

    await queue.enqueue('greet.user', { userId: 'u1' }, { singletonKey: 'u1' });
    const dropped = await queue.enqueue('greet.user', { userId: 'u1' }, { singletonKey: 'u1' });
    const other = await queue.enqueue('count.items', { amount: 1 }, { singletonKey: 'u1' });

    expect(dropped).toBeNull();
    expect(other).not.toBeNull();
    expect(queue.jobs).toHaveLength(2);
  });

  it('can be cleared between tests', async () => {
    const queue = memoryJobQueue<TestPayloads>();
    await queue.enqueue('greet.user', { userId: 'u1' });

    queue.clear();

    expect(queue.jobs).toEqual([]);
  });
});
