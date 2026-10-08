import { describe, expect, it, vi } from 'vitest';
import { selectProvider } from './factory.js';

describe('selectProvider', () => {
  it('builds only the chosen provider', () => {
    const fake = vi.fn(() => 'the fake');
    const real = vi.fn(() => 'the real one');

    const chosen = selectProvider('X_PROVIDER', 'real', { fake, real });

    expect(chosen).toBe('the real one');
    expect(real).toHaveBeenCalledTimes(1);
    expect(fake).not.toHaveBeenCalled();
  });

  it('names the variable and the valid choices on an unknown name', () => {
    expect(() =>
      selectProvider('X_PROVIDER', 'gemnii', { fake: () => 1, gemini: () => 2 }),
    ).toThrow('X_PROVIDER must be one of fake, gemini; got "gemnii"');
  });
});
