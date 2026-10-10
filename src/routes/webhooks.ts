// Incoming calls from other services, outside /v1 like the health checks.
//
//   POST /webhooks/resend   Resend tells us an email bounced or was marked
//                           as spam; we stop emailing that address.
//
// Webhooks need the body exactly as sent, byte for byte, because the
// signature covers it. So this plugin replaces the JSON parser for its own
// routes with one that keeps the raw text; the handler parses after the
// signature check. Backend notes, entry 47.

import type { FastifyPluginCallback } from 'fastify';
import type { EmailSuppressionStore, SuppressionReason } from '../db/email-suppression-store.js';
import { verifyResendWebhook } from '../providers/email/resend-webhook.js';

export interface WebhookDependencies {
  emailSuppressions: EmailSuppressionStore;
  // RESEND_WEBHOOK_SECRET; undefined until the webhook is set up in Resend.
  resendWebhookSecret: string | undefined;
  now?: () => Date;
}

// Which Resend events mean "stop sending here".
const SUPPRESSING_EVENTS: Record<string, SuppressionReason> = {
  'email.bounced': 'bounce',
  'email.complained': 'complaint',
};

export function webhookRoutes(deps: WebhookDependencies): FastifyPluginCallback {
  const now = deps.now ?? (() => new Date());

  return (app, _options, done) => {
    // Keep the body as a string for every route in this plugin.
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, next) => {
      next(null, body);
    });

    app.post('/resend', { config: { auth: 'public' } }, async (request, reply) => {
      if (deps.resendWebhookSecret === undefined) {
        request.log.warn('resend webhook received but RESEND_WEBHOOK_SECRET is not set');
        return reply.code(503).send({ received: false });
      }

      const rawBody = typeof request.body === 'string' ? request.body : '';
      const result = verifyResendWebhook({
        secret: deps.resendWebhookSecret,
        headers: request.headers,
        rawBody,
        now: now(),
      });
      if (!result.ok) {
        // Unsigned or stale: refuse without saying which check failed.
        request.log.warn({ reason: result.reason }, 'resend webhook refused');
        return reply.code(401).send({ received: false });
      }

      const reason = SUPPRESSING_EVENTS[result.event.type];
      if (reason !== undefined) {
        const at = now();
        for (const address of result.event.data.to ?? []) {
          await deps.emailSuppressions.suppress({
            email: address,
            reason,
            providerEventId: result.event.data.email_id ?? null,
            at,
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
