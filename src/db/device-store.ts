// Devices on the `devices` table.
//
// The phone identifies itself with an `install_id` it generated at first
// launch. The first request from an install creates its row; every later one
// finds the row and refreshes the app and OS versions. That is one statement,

import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { EnumValue } from './schema/enums.js';
import type { Executor } from './idempotency-store.js';
import { devices, type platformEnum } from './schema/index.js';

export type Platform = EnumValue<typeof platformEnum>;

// What the phone tells us about itself.
export interface DeviceRegistration {
  installId: string;
  platform: Platform;
  appVersion: string;
  osVersion: string;
}

export interface Device {
  id: string;
  installId: string;
  platform: Platform;
  // Null while the device is in guest mode.
  userId: string | null;
}

export interface DeviceStore {
  // The device row for this install: created now, or found and refreshed.
  register(registration: DeviceRegistration, now: Date): Promise<Device>;
  // Looks a device up by install id. Undefined when never seen.
  findByInstallId(installId: string): Promise<Device | undefined>;
  // Log out: this phone must stop receiving the user's pushes.
  clearPushToken(deviceId: string, now: Date): Promise<void>;
}

type Row = typeof devices.$inferSelect;

const toDevice = (row: Pick<Row, 'id' | 'installId' | 'platform' | 'userId'>): Device => ({
  id: row.id,
  installId: row.installId,
  platform: row.platform,
  userId: row.userId,
});

export function createDeviceStore(db: Executor): DeviceStore {
  return {
    async register(registration, now) {
      const [row] = await db
        .insert(devices)
        .values(registration)
        // On conflict, only the version fields change. `userId` and the push
        // fields are left alone: a guest-session request from a signed-in
        // phone must not detach it from its user or forget its push token.
        .onConflictDoUpdate({
          target: devices.installId,
          set: {
            platform: registration.platform,
            appVersion: registration.appVersion,
            osVersion: registration.osVersion,
            updatedAt: now,
          },
        })
        .returning();
      if (row === undefined) throw new Error('device upsert returned no row');
      return toDevice(row);
    },

    async findByInstallId(installId) {
      const row = await db.query.devices.findFirst({
        where: (table, { eq }) => eq(table.installId, installId),
      });
      return row === undefined ? undefined : toDevice(row);
    },

    async clearPushToken(deviceId, now) {
      await db
        .update(devices)
        .set({ pushToken: null, updatedAt: now })
        .where(eq(devices.id, deviceId));
    },
  };
}

// In-memory store with the same rules, for tests and for running the app
// without a database.
export function memoryDeviceStore(): DeviceStore {
  const byInstallId = new Map<string, Device>();

  return {
    register(registration) {
      const existing = byInstallId.get(registration.installId);
      const device: Device = {
        id: existing?.id ?? uuidv7(),
        installId: registration.installId,
        platform: registration.platform,
        userId: existing?.userId ?? null,
      };
      byInstallId.set(device.installId, device);
      return Promise.resolve(device);
    },
    findByInstallId(installId) {
      return Promise.resolve(byInstallId.get(installId));
    },
    clearPushToken() {
      // The memory device has no push token field to clear.
      return Promise.resolve();
    },
  };
}
