// Picks the food vision provider from FOOD_VISION_PROVIDER.
//
//   fake          fixtures, no network (tests and local development)
//   snapcalorie   SnapCalorie API                      (Phase 5.3)
//   gemini        Gemini vision + nutrition database   (Phase 5.3)

import type { Config } from '../../config/index.js';
import { notImplemented, selectProvider } from '../factory.js';
import { fakeFoodVision } from './fake.js';
import type { FoodVisionProvider } from './types.js';

export function buildFoodVisionProvider(config: Config): FoodVisionProvider {
  return selectProvider('FOOD_VISION_PROVIDER', config.FOOD_VISION_PROVIDER, {
    fake: () => fakeFoodVision(),
    snapcalorie: notImplemented('FOOD_VISION_PROVIDER=snapcalorie', 'Phase 5.3'),
    gemini: notImplemented('FOOD_VISION_PROVIDER=gemini', 'Phase 5.3'),
  });
}

export * from './types.js';
export { fakeFoodVision, FIXTURE_RESULT, type FakeFoodVision } from './fake.js';
