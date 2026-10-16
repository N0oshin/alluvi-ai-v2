// Incoming calls from the email provider, outside /v1.
//
//   POST /webhooks/resend   Resend tells us an email bounced or was marked
//                           as spam; we stop emailing that address.
//
// Webhooks need the body exactly as sent, byte for byte, because the
// signature covers it. So this plugin replaces the JSON parser for its own
// routes with one that keeps the raw text; the handler parses after the
// signature check (backend notes, entry 47).

import type { FastifyPluginCallback } from 'fastify';
import { config } from '../../config/index.js';
import { verifyResendWebhook } from '../../providers/email/resend-webhook.js';
import { suppressEmail, type SuppressionReason } from './queries.js';

// Which Resend events mean "stop sending here".
const SUPPRESSING_EVENTS: Record<string, SuppressionReason> = {
  'email.bounced': 'bounce',
  'email.complained': 'complaint',
};

export function webhookRoutes(): FastifyPluginCallback {
  // Undefined until the webhook is set up in Resend.
  const secret = config.RESEND_WEBHOOK_SECRET;

  return (app, _options, done) => {
    // Keep the body as a string for every route in this plugin.
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, next) => {
      next(null, body);
    });

    app.post('/resend', { config: { auth: 'public' } }, async (request, reply) => {
      if (secret === undefined) {
        request.log.warn('resend webhook received but RESEND_WEBHOOK_SECRET is not set');
        return reply.code(503).send({ received: false });
      }

      const now = new Date();
      const rawBody = typeof request.body === 'string' ? request.body : '';
      const result = verifyResendWebhook({ secret, headers: request.headers, rawBody, now });
      if (!result.ok) {
        // Unsigned or stale: refuse without saying which check failed.
        request.log.warn({ reason: result.reason }, 'resend webhook refused');
        return reply.code(401).send({ received: false });
      }

      const reason = SUPPRESSING_EVENTS[result.event.type];
      if (reason !== undefined) {
        for (const address of result.event.data.to ?? []) {
          await suppressEmail({
            email: address,
            reason,
            providerEventId: result.event.data.email_id ?? null,
            at: now,
          });
        }
        request.log.info(
          { event: result.event.type, recipients: (result.event.data.to ?? []).length },
          'email address suppressed',
        );
      }

      // 200 quickly, whatever the event: Resend retries anything else.
      return reply.code(200).send({ received: true });
    });

    done();
  };
}
