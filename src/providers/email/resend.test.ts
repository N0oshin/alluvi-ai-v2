import { describe, expect, it } from 'vitest';
import { resendEmail, ResendError } from './resend.js';

// A stand-in for fetch: records the one request it receives and answers
// with whatever the test says.
function fakeFetch(status: number, body: unknown) {
  // url and body are kept as text: the client always passes a string URL
  // and a JSON string body, and the linter wants that spelled out rather
  // than relying on String() over a Request or a stream.
  const calls: { url: string; init: RequestInit; body: string }[] = [];
  const impl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rawBody = init?.body;
    calls.push({ url, init: init ?? {}, body: typeof rawBody === 'string' ? rawBody : '' });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  return { impl, calls };
}

const message = {
  to: 'hamish@example.com',
  subject: 'Your link',
  text: 'Tap here',
  html: '<p>Tap here</p>',
};

describe('resendEmail', () => {
  it('posts the message to Resend with the key and From, and returns the id', async () => {
    const { impl, calls } = fakeFetch(200, { id: 'msg_123' });
    const provider = resendEmail({
      apiKey: 're_test',
      from: 'Alluvi AI <hi@alluvi.ai>',
      fetch: impl,
    });

    const result = await provider.send(message);
    expect(result).toEqual({ messageId: 'msg_123' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.resend.com/emails');
    expect(call?.init.method).toBe('POST');
    expect(new Headers(call?.init.headers).get('authorization')).toBe('Bearer re_test');
    expect(JSON.parse(call?.body ?? '')).toEqual({
      from: 'Alluvi AI <hi@alluvi.ai>',
      to: ['hamish@example.com'],
      subject: 'Your link',
      text: 'Tap here',
      html: '<p>Tap here</p>',
    });
  });

  it('omits html when the message has none', async () => {
    const { impl, calls } = fakeFetch(200, { id: 'msg_1' });
    const provider = resendEmail({ apiKey: 'k', from: 'a@b.c', fetch: impl });
    await provider.send({ to: 'x@example.com', subject: 's', text: 't' });
    expect(JSON.parse(calls[0]?.body ?? '')).not.toHaveProperty('html');
  });

  it("throws a ResendError carrying Resend's status and message when refused", async () => {
    const { impl } = fakeFetch(403, { statusCode: 403, message: 'Domain is not verified' });
    const provider = resendEmail({ apiKey: 'k', from: 'a@unverified.example', fetch: impl });

    const error = await provider.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResendError);
    expect((error as ResendError).status).toBe(403);
    expect((error as ResendError).message).toContain('Domain is not verified');
  });

  it('throws when the success body has no id', async () => {
    const { impl } = fakeFetch(200, { unexpected: true });
    const provider = resendEmail({ apiKey: 'k', from: 'a@b.c', fetch: impl });
    await expect(provider.send(message)).rejects.toBeInstanceOf(ResendError);
  });
});
