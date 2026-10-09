import { generateOpaqueToken, hashOpaqueToken } from './opaque-token.js';

// 15 minutes, single use
export const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1000;

export const MAGIC_LINK_RESEND_COOLDOWN_SECONDS = 30;

export function generateMagicLinkToken(): string {
  return generateOpaqueToken('mlt_');
}

export function hashMagicLinkToken(token: string): string {
  return hashOpaqueToken(token);
}
