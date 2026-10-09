import { createHash, randomBytes } from 'node:crypto';

// 60 days, sliding: each refresh pushes the expiry out again.
export const REFRESH_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;

// Tokens start with this so a log line or a support ticket shows what kind of
// secret leaked. The prefix carries no information and is not checked.
const PREFIX = 'rft_';

// 32 random bytes as base64url: 43 characters, nothing to guess.
export function generateRefreshToken(): string {
  return PREFIX + randomBytes(32).toString('base64url');
}

// hash it with SHA-256.s.
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
