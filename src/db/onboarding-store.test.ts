import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  testDb,
  truncateAll,
} from '../../test/db.js';
import { factories } from '../../test/factories/index.js';
import { createOnboardingStore } from './onboarding-store.js';
import { onboardingResponses } from './schema/index.js';

describeWithDatabase('createOnboardingStore', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  const store = () => createOnboardingStore(testDb());

  async function guest() {
    const device = await factories.device.create();
    return factories.guestSession.create({ deviceId: device.id });
  }

  it('creates the row on the first save and returns numbers as numbers', async () => {
    const g = await guest();
    const saved = await store().save(
      { guestSessionId: g.id },
      { sex: 'female', heightCm: 170.2, weightKg: 72.6, birthDate: '1998-03-14' },
      new Date(),
    );
    expect(saved).toMatchObject({
      sex: 'female',
      heightCm: 170.2,
      weightKg: 72.6,
      birthDate: '1998-03-14',
      goal: null,
      completedAt: null,
    });
    expect(await testDb().select().from(onboardingResponses)).toHaveLength(1);
  });

  it('updates only the answers it is given, on the same row', async () => {
    const g = await guest();
    const first = new Date('2026-10-12T10:00:00Z');
    const second = new Date('2026-10-12T10:05:00Z');
    await store().save({ guestSessionId: g.id }, { sex: 'male', goal: 'lose' }, first);
    const saved = await store().save(
      { guestSessionId: g.id },
      { goal: 'gain', obstacle: 'support' },
      second,
    );
    expect(saved).toMatchObject({ sex: 'male', goal: 'gain', obstacle: 'support' });

    const rows = await testDb().select().from(onboardingResponses);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedAt.getTime()).toBe(second.getTime());
  });

  it('does not clear anything when an answer is undefined', async () => {
    const g = await guest();
    await store().save({ guestSessionId: g.id }, { sex: 'other' }, new Date());
    const saved = await store().save({ guestSessionId: g.id }, { sex: undefined }, new Date());
    expect(saved.sex).toBe('other');
  });

  it('keeps a separate row for a user, found again by user id', async () => {
    const user = await factories.user.create();
    await store().save({ userId: user.id }, { goal: 'maintain' }, new Date());
    const saved = await store().save(
      { userId: user.id },
      { motivation: 'eat_healthier' },
      new Date(),
    );
    expect(saved).toMatchObject({ goal: 'maintain', motivation: 'eat_healthier' });

    const rows = await testDb()
      .select()
      .from(onboardingResponses)
      .where(eq(onboardingResponses.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.guestSessionId).toBeNull();
  });

  it('survives two saves arriving at the same time', async () => {
    const g = await guest();
    await Promise.all([
      store().save({ guestSessionId: g.id }, { sex: 'female' }, new Date()),
      store().save({ guestSessionId: g.id }, { goal: 'lose' }, new Date()),
    ]);
    const rows = await testDb().select().from(onboardingResponses);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sex: 'female', goal: 'lose' });
  });
});
