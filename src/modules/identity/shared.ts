// Pieces every sign-in route needs: the install id field, the consent
// checkboxes, and turning an install id into a device row.

import { z } from 'zod';
import type { ConsentDecision } from '../../db/account-store.js';
import type { Device, DeviceStore } from '../../db/device-store.js';
import { consentTypeEnum } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';

export const installIdField = z.string().min(8).max(128);

// One checkbox from screen 119, as the API spells it.
export const consentSchema = z.strictObject({
  type: z.enum(consentTypeEnum.enumValues),
  version: z.string().min(1).max(50),
  granted: z.boolean(),
});

export const consentsField = z.array(consentSchema).max(10).default([]);

// API shape (version) to code shape (documentVersion).
export function toConsentDecisions(consents: z.infer<typeof consentSchema>[]): ConsentDecision[] {
  return consents.map((c) => ({ type: c.type, documentVersion: c.version, granted: c.granted }));
}

// The device behind an install id, or 422 on the field: the phone must have
// called POST /v1/guest-sessions first (decision 37).
export async function resolveDevice(devices: DeviceStore, installId: string): Promise<Device> {
  const device = await devices.findByInstallId(installId);
  if (device === undefined) {
    throw new AppError('validation_failed', [
      {
        field: 'device_install_id',
        code: 'unknown_device',
        message: 'Register the install with POST /v1/guest-sessions first.',
      },
    ]);
  }
  return device;
}
