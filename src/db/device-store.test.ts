import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  testDb,
  truncateAll,
} from '../../test/db.js';
import { factories } from '../../test/factories/index.js';
import { createDeviceStore, memoryDeviceStore, type DeviceStore } from './device-store.js';
import { devices } from './schema/index.js';

const now = new Date('2026-10-09T10:00:00Z');
const registration = {
  installId: 'b1f6c2d4-install',
  platform: 'ios' as const,
  appVersion: '1.0.0',
  osVersion: '18.0',
};

// The rules both stores must follow. Each store runs the same block.
function behavesLikeADeviceStore(store: () => DeviceStore) {
  it('creates a device on first sight and finds it by install id', async () => {
    const device = await store().register(registration, now);
    expect(device.installId).toBe(registration.installId);
    expect(device.platform).toBe('ios');
    expect(device.userId).toBeNull();
    expect(await store().findByInstallId(registration.installId)).toEqual(device);
  });

  it('returns the same device for the same install id, with the versions refreshed', async () => {
    const first = await store().register(registration, now);
    const second = await store().register(
      { ...registration, appVersion: '1.1.0', osVersion: '18.1' },
      new Date(now.getTime() + 1000),
    );
    expect(second.id).toBe(first.id);
  });

  it('answers undefined for an install id it has never seen', async () => {
    expect(await store().findByInstallId('never-registered')).toBeUndefined();
  });
}

describe('memoryDeviceStore', () => {
  let store: DeviceStore;
  beforeEach(() => {
    store = memoryDeviceStore();
  });
  behavesLikeADeviceStore(() => store);
});

describeWithDatabase('createDeviceStore', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  behavesLikeADeviceStore(() => createDeviceStore(testDb()));

  it('refreshes the versions in the row but keeps the user and push token', async () => {
    const user = await factories.user.create();
    const seeded = await factories.device.create({
      userId: user.id,
      installId: registration.installId,
      pushToken: 'fcm-keep-me',
    });

    const device = await createDeviceStore(testDb()).register(
      { ...registration, appVersion: '2.0.0' },
      now,
    );
    expect(device.id).toBe(seeded.id);
    expect(device.userId).toBe(user.id);

    const [row] = await testDb().select().from(devices).where(eq(devices.id, seeded.id));
    expect(row?.appVersion).toBe('2.0.0');
    expect(row?.pushToken).toBe('fcm-keep-me');
    expect(row?.userId).toBe(user.id);
  });
});
