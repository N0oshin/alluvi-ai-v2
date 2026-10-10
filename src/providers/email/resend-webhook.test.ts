import { describe, expect, it } from 'vitest';
import { signResendWebhook, verifyResendWebhook } from './resend-webhook.js';

const secret = `whsec_${Buffer.from('a-test-secret-of-32-bytes-long!!').toString('base64')}`;
const now = new Date('2026-10-09T10:00:00Z');
const body = JSON.stringify({
  type: 'email.bounced',
  created_at: '2026-10-09T09:59:58.000Z',
  data: { email_id: 'msg_1', to: ['bounced@example.com'], bounce: { type: 'hard' } },
});

function signed(overrides: Partial<{ secret: string; timestamp: Date; rawBody: string }> = {}) {
  return signResendWebhook({
    secret: overrides.secret ?? secret,
    id: 'msg_evt_1',
    timestamp: overrides.timestamp ?? now,
    rawBody: overrides.rawBody ?? body,
  });
}

describe('verifyResendWebhook', () => {
  it('accepts a correctly signed, recent call and parses the event', () => {
    const result = verifyResendWebhook({ secret, headers: signed(), rawBody: body, now });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe('email.bounced');
      expect(result.event.data.to).toEqual(['bounced@example.com']);
    }
  });

  it('accepts when one of several signatures matches (secret rotation)', () => {
    const headers = signed();
    headers['svix-signature'] = `v1,AAAA ${headers['svix-signature']}`;
    expect(verifyResendWebhook({ secret, headers, rawBody: body, now }).ok).toBe(true);
  });

  it('refuses missing headers, a wrong secret, a changed body and an old timestamp', () => {
    const wrongSecret = verifyResendWebhook({
      secret,
      headers: signed({ secret: 'whsec_b3RoZXI=' }),
      rawBody: body,
      now,
    });
    expect(wrongSecret).toEqual({ ok: false, reason: 'bad_signature' });

    const tampered = verifyResendWebhook({
      secret,
      headers: signed(),
      rawBody: body.replace('bounced@', 'victim@'),
      now,
    });
    expect(tampered).toEqual({ ok: false, reason: 'bad_signature' });

    const old = verifyResendWebhook({
      secret,
      headers: signed({ timestamp: new Date(now.getTime() - 6 * 60_000) }),
      rawBody: body,
      now,
    });
    expect(old).toEqual({ ok: false, reason: 'too_old' });

    expect(verifyResendWebhook({ secret, headers: {}, rawBody: body, now })).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
  });

  it('refuses a body that is not the expected JSON shape', () => {
    const rawBody = '{"nope": true}';
    const result = verifyResendWebhook({
      secret,
      headers: signed({ rawBody }),
      rawBody,
      now,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_body' });
  });
});
