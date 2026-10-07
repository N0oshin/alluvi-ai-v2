import { describe, expect, it, vi } from 'vitest';
import { memoryIdempotencyStore } from '../../http/idempotency.js';
import { memoryRateLimitStore } from '../../http/rate-limit.js';
import type { JobContext } from '../queue.js';
import { infrastructureCleanup } from './infrastructure.js';

const info = vi.fn();
const context: JobContext = {
  id: 'job-1',
  attempt: 0,
  signal: new AbortController().signal,
  log: { info, warn: vi.fn(), error: vi.fn() },
};

describe('infrastructure.cleanup', () => {
  it('deletes expired idempotency keys and finished rate limit windows', async () => {
    const idempotencyStore = memoryIdempotencyStore(1000);
    const rateLimitStore = memoryRateLimitStore();
    const start = new Date('2026-10-07T10:00:00Z');
    await idempotencyStore.claim('s', 'old', 'h', start);
    await idempotencyStore.claim('s', 'new', 'h', new Date(start.getTime() + 5000));
    await rateLimitStore.hit('a', start);
    await rateLimitStore.hit('a', new Date(start.getTime() + 60_000));

    const handler = infrastructureCleanup({ idempotencyStore, rateLimitStore });
    await handler({ before: new Date(start.getTime() + 1000).toISOString() }, context);

    expect(info).toHaveBeenCalledWith(
      { idempotencyKeys: 1, rateLimitWindows: 1 },
      'expired rows deleted',
    );
  });
});
