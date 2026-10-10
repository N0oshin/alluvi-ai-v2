import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  testDb,
  truncateAll,
} from '../../test/db.js';
import {
  createEmailSuppressionStore,
  memoryEmailSuppressionStore,
  type EmailSuppressionStore,
} from './email-suppression-store.js';
import { emailSuppressions } from './schema/index.js';

const at = new Date('2026-10-09T10:00:00Z');

function behavesLikeASuppressionStore(store: () => EmailSuppressionStore) {
  it('is empty for an unknown address', async () => {
    expect(await store().isSuppressed('nobody@example.com')).toBe(false);
  });

  it('suppresses an address, matching in any letter case', async () => {
    await store().suppress({
      email: 'Bounced@Example.com',
      reason: 'bounce',
      providerEventId: 'e1',
      at,
    });
    expect(await store().isSuppressed('bounced@example.com')).toBe(true);
    expect(await store().isSuppressed('  BOUNCED@example.com ')).toBe(true);
  });

  it('accepts a second event for the same address', async () => {
    await store().suppress({ email: 'x@example.com', reason: 'bounce', providerEventId: 'e1', at });
    await store().suppress({
      email: 'x@example.com',
      reason: 'complaint',
      providerEventId: 'e2',
      at,
    });
    expect(await store().isSuppressed('x@example.com')).toBe(true);
  });
}

describe('memoryEmailSuppressionStore', () => {
  let store: EmailSuppressionStore;
  beforeEach(() => {
    store = memoryEmailSuppressionStore();
  });
  behavesLikeASuppressionStore(() => store);
});

describeWithDatabase('createEmailSuppressionStore', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  behavesLikeASuppressionStore(() => createEmailSuppressionStore(testDb()));

  it('keeps one row per address with the latest reason', async () => {
    const store = createEmailSuppressionStore(testDb());
    await store.suppress({ email: 'x@example.com', reason: 'bounce', providerEventId: 'e1', at });
    await store.suppress({
      email: 'x@example.com',
      reason: 'complaint',
      providerEventId: 'e2',
      at: new Date(at.getTime() + 1000),
    });
    const rows = await testDb().select().from(emailSuppressions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('complaint');
    expect(rows[0]?.providerEventId).toBe('e2');
  });
});
