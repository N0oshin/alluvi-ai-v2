import { generateOpaqueToken, hashOpaqueToken } from './opaque-token.js';

// 60 days, sliding: each refresh pushes the expiry out again.
export const REFRESH_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;

export function generateRefreshToken(): string {
  return generateOpaqueToken('rft_');
}

export function hashRefreshToken(token: string): string {
  return hashOpaqueToken(token);
}
