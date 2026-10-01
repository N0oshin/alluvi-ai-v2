import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('app skeleton', () => {
  it('builds and stops without opening a port', async () => {
    const app = buildApp();
    await expect(app.stop()).resolves.toBeUndefined();
  });
});
