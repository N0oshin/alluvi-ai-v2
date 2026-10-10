import { describe, expect, it } from 'vitest';
import { fakeDeps } from '../../test/app-deps.js';
import { buildApp } from '../app.js';
import { memoryEmailSuppressionStore } from '../db/email-suppression-store.js';
import { signResendWebhook } from '../providers/email/resend-webhook.js';

const secret = `whsec_${Buffer.from('a-test-secret-of-32-bytes-long!!').toString('base64')}`;

function setup(configured = true) {
  const emailSuppressions = memoryEmailSuppressionStore();
  const deps = fakeDeps({
    emailSuppressions,
    resendWebhookSecret: configured ? secret : undefined,
  });
  return { app: buildApp(deps), emailSuppressions };
}

function post(app: ReturnType<typeof buildApp>, event: object, headers?: Record<string, string>) {
  const rawBody = JSON.stringify(event);
  return app.inject({
    method: 'POST',
    url: '/webhooks/resend',
    headers: {
      'content-type': 'application/json',
      ...(headers ?? signResendWebhook({ secret, id: 'evt_1', timestamp: new Date(), rawBody })),
    },
    payload: rawBody,
  });
}

describe('POST /webhooks/resend', () => {
  it('records a bounce against the address and answers 200', async () => {
    const { app, emailSuppressions } = setup();
    const response = await post(app, {
      type: 'email.bounced',
      data: { email_id: 'msg_9', to: ['Bounced@Example.com'] },
    });
    expect(response.statusCode).toBe(200);
    expect(await emailSuppressions.isSuppressed('bounced@example.com')).toBe(true);
    expect(emailSuppressions.suppressed.get('bounced@example.com')?.reason).toBe('bounce');
  });

  it('records a complaint, and ignores other events with 200', async () => {
    const { app, emailSuppressions } = setup();
    await post(app, { type: 'email.complained', data: { to: ['spam@example.com'] } });
    expect(await emailSuppressions.isSuppressed('spam@example.com')).toBe(true);

    const delivered = await post(app, {
      type: 'email.delivered',
      data: { to: ['ok@example.com'] },
    });
    expect(delivered.statusCode).toBe(200);
    expect(await emailSuppressions.isSuppressed('ok@example.com')).toBe(false);
  });

  it('refuses an unsigned or badly signed call with 401 and records nothing', async () => {
    const { app, emailSuppressions } = setup();
    const unsigned = await post(
      app,
      { type: 'email.bounced', data: { to: ['x@example.com'] } },
      {},
    );
    expect(unsigned.statusCode).toBe(401);

    const wrongSecret = await post(
      app,
      { type: 'email.bounced', data: { to: ['x@example.com'] } },
      signResendWebhook({
        secret: 'whsec_d3Jvbmc=',
        id: 'evt_2',
        timestamp: new Date(),
        rawBody: JSON.stringify({ type: 'email.bounced', data: { to: ['x@example.com'] } }),
      }),
    );
    expect(wrongSecret.statusCode).toBe(401);
    expect(await emailSuppressions.isSuppressed('x@example.com')).toBe(false);
  });

  it('answers 503 when the secret is not configured', async () => {
    const { app } = setup(false);
    const response = await post(app, { type: 'email.bounced', data: { to: ['x@example.com'] } });
    expect(response.statusCode).toBe(503);
  });
});
