// The food vision provider: what the scan pipeline needs from whichever
// vendor recognises food in a photo (document 04 section 5.3).
//
// The pipeline never talks to SnapCalorie or Gemini directly. It talks to
// this interface, and a factory (./index.ts) picks the implementation from
// FOOD_VISION_PROVIDER. Every implementation returns the same normalised
// AnalysisResult, so validation and the health score are vendor-neutral.
// The validator for AnalysisResult and the real implementations arrive in
// Phase 5.3; the interface is settled here so the rest of the code can be
// written against it.

export type AnalysisMode = 'scan_food' | 'food_label';

export interface Ingredient {
  name: string;
  caloriesKcal: number;
}

// Per serving. Field names carry the unit, as the API does.
export interface Nutrients {
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  sugarG: number;
  sodiumMg: number;
}

export interface AnalysisResult {
  title: string;
  servingsDetected: number;
  perServing: Nutrients;
  ingredients: Ingredient[];
  // 0 to 1. Lower when the vendor was unsure or an ingredient was estimated.
  confidence: number;
}

export interface AnalyzeImageInput {
  // The storage key of the uploaded photo (the StorageProvider holds it).
  imageKey: string;
  mode: AnalysisMode;
  // "Fix results": the user's correction and the result it corrects.
  fixPrompt?: string;
  previousResult?: AnalysisResult;
}

export type BarcodeLookup = { found: true; result: AnalysisResult } | { found: false };

export interface FoodVisionProvider {
  analyzeImage(input: AnalyzeImageInput): Promise<AnalysisResult>;
  lookupBarcode(value: string, format: string): Promise<BarcodeLookup>;
  // Recorded on every scan, so a result can always be traced to the model
  // that produced it.
  describe(): { provider: string; modelVersion: string };
}
