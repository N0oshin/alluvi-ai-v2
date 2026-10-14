// The page a magic link opens in the browser (decision 51). It is served by
// the API itself at the path of MAGIC_LINK_BASE_URL, on any device.
//
// The page does nothing on load: a link scanner that fetches every URL in an
// email must not count as the person. It shows who the sign-in is for and a
// button. The button's JavaScript reads the token from the page's own URL and
// POSTs it to /v1/auth/email/magic-links/open on the same origin, which is
// why MAGIC_LINK_BASE_URL has to live on the API's host. The token is never
// written into the HTML.

import { escapeHtml } from './magic-link-email.js';
import type { MagicIntent } from '../../db/magic-link-store.js';

export type MagicLinkPageState =
  // A live, unopened link: show the confirm button.
  | 'confirm'
  // Already confirmed; the app will have signed in or will on its next poll.
  | 'opened'
  | 'expired'
  | 'used'
  | 'invalid';

export interface MagicLinkPageInput {
  state: MagicLinkPageState;
  // Shown masked, so a page screenshot gives away little.
  email?: string;
  intent?: MagicIntent;
}

// 'hamish@example.com' -> 'h•••••@example.com'
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '•••••';
  return `${email[0]}•••••${email.slice(at)}`;
}

const copy: Record<Exclude<MagicLinkPageState, 'confirm'>, { title: string; body: string }> = {
  opened: {
    title: "You're signed in",
    body: 'Go back to the Alluvi AI app on your phone. You can close this tab.',
  },
  expired: {
    title: 'This link has expired',
    body: 'Links work for 15 minutes. Open the app and request a new one.',
  },
  used: {
    title: 'This link was already used',
    body: 'If that was you, you are signed in on your phone. Otherwise open the app and request a new link.',
  },
  invalid: {
    title: 'This link is not valid',
    body: 'Open the app and request a new link.',
  },
};

const STYLE = `
  body{margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a}
  main{max-width:420px;margin:48px auto;background:#fff;border-radius:12px;padding:32px}
  h1{font-size:22px;margin:0 0 12px}
  p{font-size:16px;line-height:24px;margin:0 0 20px;color:#333}
  button{display:inline-block;width:100%;background:#1a1a1a;color:#fff;border:0;padding:14px 24px;border-radius:999px;font-size:16px;font-weight:600;cursor:pointer}
  button[disabled]{opacity:.6;cursor:default}
  #status{min-height:24px;font-size:14px;color:#b00020;margin-top:12px}
`;

// Plain, old-style JavaScript so it runs in any browser an email app opens.
const SCRIPT = `
(function () {
  var token = new URLSearchParams(location.search).get('token');
  var button = document.getElementById('confirm');
  var status = document.getElementById('status');
  var done = document.getElementById('done');
  var ask = document.getElementById('ask');
  button.addEventListener('click', function () {
    button.disabled = true;
    status.textContent = '';
    fetch('/v1/auth/email/magic-links/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    }).then(function (response) {
      return response.json().then(function (body) { return { ok: response.ok, body: body }; });
    }).then(function (result) {
      if (result.ok) { ask.hidden = true; done.hidden = false; return; }
      status.textContent = (result.body && result.body.error && result.body.error.message) || 'Something went wrong. Try again.';
      button.disabled = false;
    }).catch(function () {
      status.textContent = 'Something went wrong. Check your connection and try again.';
      button.disabled = false;
    });
  });
})();
`;

function page(title: string, main: string, script = ''): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>${escapeHtml(title)} · Alluvi AI</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <main>${main}</main>${script === '' ? '' : `\n    <script>${script}</script>`}
  </body>
</html>
`;
}

export function magicLinkPage(input: MagicLinkPageInput): string {
  if (input.state !== 'confirm') {
    const { title, body } = copy[input.state];
    return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`);
  }

  const who = input.email === undefined ? 'your account' : escapeHtml(maskEmail(input.email));
  const action = input.intent === 'sign_up' ? 'finish creating the account' : 'sign in';
  const done = copy.opened;
  const main = `
      <div id="ask">
        <h1>Confirm it's you</h1>
        <p>Someone asked to ${action} for <strong>${who}</strong> in the Alluvi AI app. If that was you, confirm below and the app on your phone will sign in.</p>
        <p>If it wasn't you, close this page. Nothing happens unless you confirm.</p>
        <button id="confirm" type="button">Yes, sign me in</button>
        <div id="status" role="status"></div>
      </div>
      <div id="done" hidden>
        <h1>${escapeHtml(done.title)}</h1><p>${escapeHtml(done.body)}</p>
      </div>`;
  return page("Confirm it's you", main, SCRIPT);
}
