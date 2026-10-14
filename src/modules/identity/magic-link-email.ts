import type { EmailMessage } from '../../providers/email/index.js';
import type { MagicIntent } from '../../db/magic-link-store.js';

export interface MagicLinkEmailInput {
  to: string;
  link: string;
  intent: MagicIntent;
  expiresInMinutes: number;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function magicLinkEmail(input: MagicLinkEmailInput): EmailMessage {
  const action = input.intent === 'sign_up' ? 'finish creating your account' : 'sign in';
  const subject =
    input.intent === 'sign_up' ? 'Your Alluvi AI sign-up link' : 'Your Alluvi AI sign-in link';

  const text = [
    `Open the link below on any device and confirm it's you to ${action}. The Alluvi AI app on your phone will then sign in.`,
    '',
    input.link,
    '',
    `The link works once and expires in ${input.expiresInMinutes} minutes.`,
    "If you didn't request it, you can ignore this email. Nothing happens unless you confirm.",
    '',
    'Alluvi AI',
  ].join('\n');

  const link = escapeHtml(input.link);
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
      <p style="font-size:16px;line-height:24px;margin:0 0 24px">Open the button below on any device and confirm it's you to ${action}. The Alluvi AI app on your phone will then sign in.</p>
      <p style="margin:0 0 24px">
        <a href="${link}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:14px 24px;border-radius:999px;font-weight:600">Confirm sign-in</a>
      </p>
      <p style="font-size:14px;line-height:20px;color:#555;margin:0 0 8px">Or copy this link into a browser:</p>
      <p style="font-size:14px;line-height:20px;word-break:break-all;margin:0 0 24px"><a href="${link}" style="color:#1a1a1a">${link}</a></p>
      <p style="font-size:14px;line-height:20px;color:#555;margin:0">The link works once and expires in ${input.expiresInMinutes} minutes. If you didn't request it, you can ignore this email. Nothing happens unless you confirm.</p>
    </div>
  </body>
</html>`;

  return { to: input.to, subject, text, html };
}
