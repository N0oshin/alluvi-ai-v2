// The fake vision provider: answers instantly with a fixture, no network,
// no key. Used by every test and by `npm run dev` when no vendor is set.

import type {
  AnalysisResult,
  AnalyzeImageInput,
  BarcodeLookup,
  FoodVisionProvider,
} from './types.js';

export const FIXTURE_RESULT: AnalysisResult = {
  title: 'Grilled chicken salad',
  servingsDetected: 1,
  perServing: {
    caloriesKcal: 420,
    proteinG: 38,
    carbsG: 12,
    fatG: 24,
    fiberG: 4,
    sugarG: 5,
    sodiumMg: 640,
  },
  ingredients: [
    { name: 'Grilled chicken breast', caloriesKcal: 220 },
    { name: 'Mixed leaves', caloriesKcal: 20 },
    { name: 'Olive oil dressing', caloriesKcal: 180 },
  ],
  confidence: 0.92,
};

export interface FakeFoodVision extends FoodVisionProvider {
  // What the fake has been asked, for assertions.
  readonly calls: AnalyzeImageInput[];
  // Changes the next answers. `barcodes` maps a barcode value to its result.
  readonly barcodes: Map<string, AnalysisResult>;
  result: AnalysisResult;
}

export function fakeFoodVision(result: AnalysisResult = FIXTURE_RESULT): FakeFoodVision {
  const calls: AnalyzeImageInput[] = [];
  const barcodes = new Map<string, AnalysisResult>();

  return {
    calls,
    barcodes,
    result,
    analyzeImage(input) {
      calls.push(input);
      // A fix request returns the previous result with the prompt as title,
      // so a test can see the correction was applied.
      if (input.fixPrompt !== undefined && input.previousResult !== undefined) {
        return Promise.resolve({ ...input.previousResult, title: input.fixPrompt });
      }
      return Promise.resolve(this.result);
    },
    lookupBarcode(value): Promise<BarcodeLookup> {
      const found = barcodes.get(value);
      return Promise.resolve(
        found === undefined ? { found: false } : { found: true, result: found },
      );
    },
    describe() {
      return { provider: 'fake', modelVersion: 'fixture-1' };
    },
  };
}
