import { describe, expect, it } from 'vitest';
import { generateGuestToken, GUEST_TOKEN_LIFETIME_MS, hashGuestToken } from './guest-token.js';
import { generateRefreshToken } from './refresh-token.js';

describe('guest tokens', () => {
  it('generates a gst_ token with 32 bytes of randomness, different every time', () => {
    const a = generateGuestToken();
    expect(a).toMatch(/^gst_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(generateGuestToken());
    // Different prefix from a refresh token, so the two are never confused.
    expect(generateRefreshToken()).toMatch(/^rft_/);
  });

  it('hashes to 64 lowercase hex characters', () => {
    expect(hashGuestToken(generateGuestToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lives 30 days', () => {
    expect(GUEST_TOKEN_LIFETIME_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
