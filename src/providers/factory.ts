//  the shared picker. Nothing service-specific.
//
//
// This helper is the picking part:
//
//   const vision = selectProvider('FOOD_VISION_PROVIDER', config.FOOD_VISION_PROVIDER, {
//     fake: () => fakeFoodVision(),
//     gemini: () => geminiFoodVision(config),
//   });
//
// The table's keys are the allowed names. Each value is a function that
// builds the provider, so only the chosen one is constructed: the Gemini
// client is never created when the fake is selected.

// `Record<Name, () => T>`: an object whose keys are the allowed names and
// whose values build a T.
export type ProviderTable<Name extends string, T> = Record<Name, () => T>;

export function selectProvider<Name extends string, T>(
  variable: string,
  chosen: string,
  table: ProviderTable<Name, T>,
): T {
  const names = Object.keys(table) as Name[];
  const name = names.find((candidate) => candidate === chosen);

  if (name === undefined) {
    // Fail at start-up with the valid choices spelled out, rather than at
    // the first request that needs the provider.
    throw new Error(`${variable} must be one of ${names.join(', ')}; got "${chosen}"`);
  }
  return table[name]();
}

// A table entry for a vendor whose implementation is not written yet. Choosing
// it fails at start-up with a message saying which phase adds it, so the
// config enum can already list every planned vendor.
export function notImplemented<T>(choice: string, phase: string): () => T {
  return () => {
    throw new Error(`${choice} is not implemented yet; it arrives in ${phase}. Use fake for now.`);
  };
}
