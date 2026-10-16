// The external services, gathered into one object so the app passes a single
// thing around. Each has a real implementation chosen by the environment and
// a fake for tests and development.
//
//   vision/   FoodVisionProvider  FOOD_VISION_PROVIDER = fake | snapcalorie | gemini
//   email/    EmailProvider       EMAIL_PROVIDER       = fake | resend
//   push/     PushProvider        PUSH_PROVIDER        = fake | fcm
//   storage/  StorageProvider     STORAGE_PROVIDER     = fake | s3
//   identityTokens                Apple and Google sign-in verification, each
//                                 present only when its client ids are set

import type { Config } from '../config/index.js';
import {
  buildIdentityTokenVerifiers,
  type IdentityTokenVerifiers,
} from '../shared/auth/identity-token.js';
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
  identityTokens: IdentityTokenVerifiers;
}

// The real set, chosen by the environment. Throws at start-up on an unknown
// name or a vendor whose implementation does not exist yet.
export function buildProviders(config: Config): Providers {
  return {
    vision: buildFoodVisionProvider(config),
    email: buildEmailProvider(config),
    push: buildPushProvider(config),
    storage: buildStorageProvider(config),
    identityTokens: buildIdentityTokenVerifiers(config),
  };
}

// Every fake, with their recording fields visible, for tests. No identity
// token verifiers: a test that needs them builds its own over a local key.
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
    identityTokens: {},
  };
}

export { selectProvider, notImplemented } from './factory.js';
