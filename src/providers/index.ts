//  Four folders each produce one provider; this file gathers them into one object so the rest of the app passes a single thing around.
//
//   vision/   FoodVisionProvider  FOOD_VISION_PROVIDER = fake | snapcalorie | gemini  (Phase 5.3)
//   email/    EmailProvider       EMAIL_PROVIDER       = fake | resend              (Phase 2.3)
//   push/     PushProvider        PUSH_PROVIDER        = fake | fcm                 (Phase 10.2)
//   storage/  StorageProvider     STORAGE_PROVIDER     = fake | s3                  (Phase 1.5)
//

import type { Config } from '../config/index.js';
import {
  buildEmailProvider,
  fakeEmail,
  type EmailProvider,
  type FakeEmail,
} from './email/index.js';
import { buildPushProvider, fakePush, type FakePush, type PushProvider } from './push/index.js';
import {
  buildStorageProvider,
  fakeStorage,
  type FakeStorage,
  type StorageProvider,
} from './storage/index.js';
import {
  buildFoodVisionProvider,
  fakeFoodVision,
  type FakeFoodVision,
  type FoodVisionProvider,
} from './vision/index.js';

export interface Providers {
  vision: FoodVisionProvider;
  email: EmailProvider;
  push: PushProvider;
  storage: StorageProvider;
}

// The real set, chosen by the environment. Throws at start-up on an unknown
// name or a vendor whose implementation does not exist yet.
export function buildProviders(config: Config): Providers {
  return {
    vision: buildFoodVisionProvider(config),
    email: buildEmailProvider(config),
    push: buildPushProvider(config),
    storage: buildStorageProvider(config),
  };
}

// Every fake, with their recording fields visible, for tests.
export interface FakeProviders extends Providers {
  vision: FakeFoodVision;
  email: FakeEmail;
  push: FakePush;
  storage: FakeStorage;
}

export function fakeProviders(): FakeProviders {
  return {
    vision: fakeFoodVision(),
    email: fakeEmail(),
    push: fakePush(),
    storage: fakeStorage(),
  };
}

export { selectProvider, notImplemented } from './factory.js';
