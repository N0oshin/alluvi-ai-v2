// The Resend email provider: POST https://api.resend.com/emails.
//
// One HTTP call per message, with Node's built-in fetch. The function that
// does the HTTP call is injectable so the test can stand in for Resend
// without a network. Backend notes, entry 46.

import type { EmailMessage, EmailProvider } from './types.js';

export interface ResendOptions {
  apiKey: string;
  // The From header, e.g. 'Alluvi AI <hello@alluvi.ai>'. The domain must be
  // verified in the Resend dashboard or every send is refused.
  from: string;
  // Defaults to the global fetch; tests pass a fake.
  fetch?: typeof fetch;
  baseUrl?: string;
}

// What Resend answers on success.
interface ResendAccepted {
  id: string;
}

// Thrown when Resend refuses or cannot be reached. The message carries the
// status and Resend's own text; the caller logs it and answers 503.
export class ResendError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Resend refused the message (${status}): ${detail}`);
    this.name = 'ResendError';
    this.status = status;
  }
}

export function resendEmail(options: ResendOptions): EmailProvider {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl ?? 'https://api.resend.com'}/emails`;

  return {
    async send(message: EmailMessage) {
      const response = await doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
        }),
      });

      if (!response.ok) {
        // Resend's error body is JSON with a `message`; fall back to the
        // raw text if it is not.
        const detail = await response.text();
        let summary = detail;
        try {
          const parsed = JSON.parse(detail) as { message?: unknown };
          if (typeof parsed.message === 'string') summary = parsed.message;
        } catch {
          // keep the raw text
        }
        throw new ResendError(response.status, summary.slice(0, 500));
      }

      const accepted = (await response.json()) as Partial<ResendAccepted>;
      if (typeof accepted.id !== 'string') {
        throw new ResendError(response.status, 'response had no message id');
      }
      return { messageId: accepted.id };
    },
  };
}
