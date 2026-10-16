// This file answers one question: "is the text in ACCESS_TOKEN_KEYS (.env)a valid list of keys?
//
// A key is a private Ed25519 key in JWK (JSON Web Key) form plus a `kid`, a
// short name the token carries in its header so the verifier knows which key
// to check against. ACCESS_TOKEN_KEYS is a JSON array of them

import { z } from 'zod';

export const accessTokenKeySchema = z.strictObject({
  kid: z.string().min(1).max(64),
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  // Public and private parts, base64url. `d` is the secret.
  x: z.string().min(1),
  d: z.string().min(1),
});

export type AccessTokenKey = z.infer<typeof accessTokenKeySchema>;

const keyListSchema = z.array(accessTokenKeySchema).min(1);

// Parses the environment variable. Throws an Error whose message says what is
// wrong, so loadConfig can report it under the variable's name.
export function parseAccessTokenKeys(json: string): AccessTokenKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('must be a JSON array of keys;');
  }
  const result = keyListSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join('.') || '(root)';
    throw new Error(`invalid key list at ${where}: ${first?.message ?? 'unknown'}`);
  }
  const kids = result.data.map((key) => key.kid);
  if (new Set(kids).size !== kids.length) {
    throw new Error('every key needs a different kid');
  }
  return result.data;
}
