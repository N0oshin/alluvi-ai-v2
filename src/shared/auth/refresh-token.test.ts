import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_LIFETIME_MS,
} from './refresh-token.js';

describe('refresh tokens', () => {
  it('generates a prefixed token with 32 bytes of randomness, different every time', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).toMatch(/^rft_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashes to 64 lowercase hex characters, the shape the sessions table checks', () => {
    const hash = hashRefreshToken(generateRefreshToken());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken('rft_x')).toBe(hashRefreshToken('rft_x'));
    expect(hashRefreshToken('rft_x')).not.toBe(hashRefreshToken('rft_y'));
  });

  it('lives 60 days', () => {
    expect(REFRESH_TOKEN_LIFETIME_MS).toBe(60 * 24 * 60 * 60 * 1000);
  });
});
