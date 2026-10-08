import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/schema.js';
import { fakeProviders, buildProviders } from './index.js';
import { FIXTURE_RESULT } from './vision/index.js';

const env = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('buildProviders', () => {
  it('builds the fakes by default outside production', () => {
    const providers = buildProviders(loadConfig(env));

    expect(providers.vision.describe()).toEqual({ provider: 'fake', modelVersion: 'fixture-1' });
  });

  it('refuses a vendor that is not implemented yet, naming the phase', () => {
    expect(() => buildProviders(loadConfig({ ...env, EMAIL_PROVIDER: 'resend' }))).toThrow(
      'EMAIL_PROVIDER=resend is not implemented yet; it arrives in Phase 2.3',
    );
  });

  it('refuses an unknown provider name at configuration time', () => {
    expect(() => loadConfig({ ...env, PUSH_PROVIDER: 'apns' })).toThrow('PUSH_PROVIDER');
  });

  it('refuses fake providers in production', () => {
    expect(() =>
      loadConfig({
        ...env,
        NODE_ENV: 'production',
        FOOD_VISION_PROVIDER: 'gemini',
        STORAGE_PROVIDER: 's3',
      }),
    ).toThrow(
      /EMAIL_PROVIDER: must not be fake in production[\s\S]*PUSH_PROVIDER: must not be fake/,
    );
  });
});

describe('fake vision', () => {
  it('returns the fixture and records the call', async () => {
    const { vision } = fakeProviders();

    const result = await vision.analyzeImage({ imageKey: 'media/a.jpg', mode: 'scan_food' });

    expect(result).toEqual(FIXTURE_RESULT);
    expect(vision.calls).toEqual([{ imageKey: 'media/a.jpg', mode: 'scan_food' }]);
  });

  it('applies a fix prompt to the previous result', async () => {
    const { vision } = fakeProviders();

    const result = await vision.analyzeImage({
      imageKey: 'media/a.jpg',
      mode: 'scan_food',
      fixPrompt: 'It was salmon, not chicken',
      previousResult: FIXTURE_RESULT,
    });

    expect(result.title).toBe('It was salmon, not chicken');
    expect(result.perServing).toEqual(FIXTURE_RESULT.perServing);
  });

  it('looks up only the barcodes a test registered', async () => {
    const { vision } = fakeProviders();
    vision.barcodes.set('5000112637922', { ...FIXTURE_RESULT, title: 'Cola' });

    expect(await vision.lookupBarcode('5000112637922', 'ean13')).toEqual({
      found: true,
      result: { ...FIXTURE_RESULT, title: 'Cola' },
    });
    expect(await vision.lookupBarcode('0000', 'ean13')).toEqual({ found: false });
  });
});

describe('fake email', () => {
  it('keeps sent messages and can fail once on demand', async () => {
    const { email } = fakeProviders();
    const message = { to: 'ann@example.com', subject: 'Your link', text: 'https://…' };

    const first = await email.send(message);
    email.failNextWith = new Error('rate limited by vendor');
    await expect(email.send(message)).rejects.toThrow('rate limited by vendor');
    const third = await email.send(message);

    expect(first.messageId).toBe('fake-email-1');
    expect(third.messageId).toBe('fake-email-2');
    expect(email.sent).toHaveLength(2);
  });
});

describe('fake push', () => {
  it('sends to normal tokens and reports invalid ones', async () => {
    const { push } = fakeProviders();

    const ok = await push.send({ token: 'tok-1', title: 'Hi', body: 'There' });
    const bad = await push.send({ token: 'invalid-tok', title: 'Hi', body: 'There' });

    expect(ok).toEqual({ status: 'sent' });
    expect(bad).toEqual({ status: 'invalid_token' });
    expect(push.sent).toHaveLength(1);
  });
});

describe('fake storage', () => {
  it('issues URLs with the right lifetimes and tracks what was put', async () => {
    const { storage } = fakeProviders();
    const before = Date.now();

    const upload = await storage.createUploadUrl({
      key: 'media/u1/a.jpg',
      contentType: 'image/jpeg',
      maxBytes: 5_000_000,
    });
    expect(upload.method).toBe('PUT');
    expect(upload.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(upload.expiresAt.getTime() - before).toBeGreaterThanOrEqual(10 * 60 * 1000 - 50);

    expect(await storage.exists('media/u1/a.jpg')).toBe(false);
    storage.put('media/u1/a.jpg');
    expect(await storage.exists('media/u1/a.jpg')).toBe(true);

    const download = await storage.createDownloadUrl('media/u1/a.jpg');
    expect(download.url).toContain('media%2Fu1%2Fa.jpg');
    expect(download.expiresAt.getTime() - before).toBeLessThanOrEqual(5 * 60 * 1000 + 50);

    await storage.delete('media/u1/a.jpg');
    await storage.delete('media/u1/a.jpg');
    expect(await storage.exists('media/u1/a.jpg')).toBe(false);
  });
});
