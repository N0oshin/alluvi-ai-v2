import { generateOpaqueToken, hashOpaqueToken } from './opaque-token.js';

// 30 days, fixed: a guest who has not signed up in a month starts over.
export const GUEST_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export function generateGuestToken(): string {
  return generateOpaqueToken('gst_');
}

export function hashGuestToken(token: string): string {
  return hashOpaqueToken(token);
}
