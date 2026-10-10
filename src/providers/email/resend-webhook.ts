// Checking and reading a webhook call from Resend.
//
// Resend signs each call the "Svix" way (Svix is the service Resend uses to
// deliver webhooks). Three headers arrive with the raw JSON body:
//
//   svix-id          a unique id for this delivery
//   svix-timestamp   seconds since 1970 when it was signed
//   svix-signature   "v1,<base64 HMAC>" (several, space separated, during a
//                    secret rotation)
//
// The signature is HMAC-SHA256 over "<id>.<timestamp>.<body>" with the
// secret from the Resend dashboard ("whsec_" followed by base64 bytes). A
// call older than five minutes is refused even if the signature is right,
// so a captured call cannot be replayed later. Backend notes, entry 47.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

// The events we act on. Anything else is acknowledged and ignored.
const eventSchema = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z
    .object({
      email_id: z.string().optional(),
      to: z.array(z.string()).optional(),
    })
    .passthrough(),
});

export type ResendEvent = z.infer<typeof eventSchema>;

export type WebhookRefusal =
  'missing_headers' | 'bad_timestamp' | 'too_old' | 'bad_signature' | 'bad_body';

export type WebhookResult =
  { ok: true; event: ResendEvent } | { ok: false; reason: WebhookRefusal };

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function secretBytes(secret: string): Buffer {
  return Buffer.from(
    secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret,
    'base64',
  );
}

export function verifyResendWebhook(input: {
  secret: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
  now?: Date;
}): WebhookResult {
  const id = headerValue(input.headers, 'svix-id');
  const timestamp = headerValue(input.headers, 'svix-timestamp');
  const signatures = headerValue(input.headers, 'svix-signature');
  if (id === undefined || timestamp === undefined || signatures === undefined) {
    return { ok: false, reason: 'missing_headers' };
  }

  const signedAt = Number(timestamp);
  if (!Number.isInteger(signedAt)) return { ok: false, reason: 'bad_timestamp' };
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - signedAt) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'too_old' };
  }

  const expected = createHmac('sha256', secretBytes(input.secret))
    .update(`${id}.${timestamp}.${input.rawBody}`)
    .digest();

  // Accept if any "v1,<sig>" entry matches. timingSafeEqual compares in
  // constant time so an attacker cannot learn the signature byte by byte.
  const matches = signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || value === undefined) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) return { ok: false, reason: 'bad_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, reason: 'bad_body' };
  }
  const event = eventSchema.safeParse(parsed);
  if (!event.success) return { ok: false, reason: 'bad_body' };
  return { ok: true, event: event.data };
}

// For tests and tooling: produce the three headers Resend would send.
export function signResendWebhook(input: {
  secret: string;
  id: string;
  timestamp: Date;
  rawBody: string;
}): Record<string, string> {
  const timestamp = String(Math.floor(input.timestamp.getTime() / 1000));
  const signature = createHmac('sha256', secretBytes(input.secret))
    .update(`${input.id}.${timestamp}.${input.rawBody}`)
    .digest('base64');
  return {
    'svix-id': input.id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  };
}
