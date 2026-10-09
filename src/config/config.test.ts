import { describe, expect, it } from 'vitest';
import { loadConfig } from './schema.js';

// A complete, valid set of variables that each test can start from.
const valid = {
  NODE_ENV: 'test',
  PORT: '4000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/alluvi_test',
};

describe('loadConfig', () => {
  it('accepts a valid environment and converts PORT to a number', () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(4000);
    expect(config.NODE_ENV).toBe('test');
  });

  it('applies defaults for optional variables', () => {
    const { NODE_ENV: _env, PORT: _port, ...withoutDefaults } = valid;
    const config = loadConfig(withoutDefaults);
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
  });

  it('defaults LOG_LEVEL from NODE_ENV and accepts an explicit value', () => {
    expect(loadConfig({ ...valid, NODE_ENV: 'development' }).LOG_LEVEL).toBe('debug');
    expect(loadConfig({ ...valid, NODE_ENV: 'test' }).LOG_LEVEL).toBe('silent');
    // Production refuses fake providers and requires signing keys, so name
    // real ones here.
    const production = {
      ...valid,
      NODE_ENV: 'production',
      FOOD_VISION_PROVIDER: 'gemini',
      EMAIL_PROVIDER: 'resend',
      PUSH_PROVIDER: 'fcm',
      STORAGE_PROVIDER: 's3',
      ACCESS_TOKEN_KEYS: JSON.stringify([
        { kid: 'k1', kty: 'OKP', crv: 'Ed25519', x: 'public', d: 'secret' },
      ]),
      APPLE_CLIENT_IDS: 'ai.alluvi.app',
      GOOGLE_CLIENT_IDS: 'ios-id.apps.googleusercontent.com, android-id.apps.googleusercontent.com',
      RESEND_API_KEY: 're_test',
      EMAIL_FROM: 'Alluvi AI <hello@alluvi.ai>',
    };
    expect(() => loadConfig({ ...production, RESEND_API_KEY: undefined })).toThrow(
      /RESEND_API_KEY: is required when EMAIL_PROVIDER=resend/,
    );
    expect(loadConfig(production).LOG_LEVEL).toBe('info');
    expect(loadConfig(production).GOOGLE_CLIENT_IDS).toEqual([
      'ios-id.apps.googleusercontent.com',
      'android-id.apps.googleusercontent.com',
    ]);
    expect(() => loadConfig({ ...production, APPLE_CLIENT_IDS: '' })).toThrow(
      /APPLE_CLIENT_IDS: is required/,
    );
    expect(loadConfig({ ...valid, LOG_LEVEL: 'warn' }).LOG_LEVEL).toBe('warn');
  });

  it('rejects an unknown LOG_LEVEL and names it', () => {
    expect(() => loadConfig({ ...valid, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('accepts an optional TEST_DATABASE_URL, which may equal DATABASE_URL', () => {
    expect(loadConfig(valid).TEST_DATABASE_URL).toBeUndefined();
    expect(loadConfig({ ...valid, TEST_DATABASE_URL: valid.DATABASE_URL }).TEST_DATABASE_URL).toBe(
      valid.DATABASE_URL,
    );
    expect(() => loadConfig({ ...valid, TEST_DATABASE_URL: 'not-a-url' })).toThrow(
      /TEST_DATABASE_URL/,
    );
  });

  it('rejects a missing required variable and names it', () => {
    const { DATABASE_URL: _url, ...missing } = valid;
    expect(() => loadConfig(missing)).toThrow(/DATABASE_URL/);
  });

  it('rejects a database URL with the wrong protocol', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  describe('ACCESS_TOKEN_KEYS', () => {
    const key = { kid: 'k1', kty: 'OKP', crv: 'Ed25519', x: 'public', d: 'secret' };

    it('is optional outside production and parsed into a list when set', () => {
      expect(loadConfig(valid).ACCESS_TOKEN_KEYS).toBeUndefined();
      const config = loadConfig({ ...valid, ACCESS_TOKEN_KEYS: JSON.stringify([key]) });
      expect(config.ACCESS_TOKEN_KEYS).toEqual([key]);
    });

    it('names the variable when the value is not a key list', () => {
      expect(() => loadConfig({ ...valid, ACCESS_TOKEN_KEYS: 'nope' })).toThrow(
        /ACCESS_TOKEN_KEYS: must be a JSON array/,
      );
    });

    it('is required in production', () => {
      const production = {
        ...valid,
        NODE_ENV: 'production',
        FOOD_VISION_PROVIDER: 'gemini',
        EMAIL_PROVIDER: 'resend',
        PUSH_PROVIDER: 'fcm',
        STORAGE_PROVIDER: 's3',
        APPLE_CLIENT_IDS: 'ai.alluvi.app',
        GOOGLE_CLIENT_IDS: 'web.apps.googleusercontent.com',
        RESEND_API_KEY: 're_test',
        EMAIL_FROM: 'Alluvi AI <hello@alluvi.ai>',
      };
      expect(() => loadConfig(production)).toThrow(/ACCESS_TOKEN_KEYS: is required/);
      expect(
        loadConfig({ ...production, ACCESS_TOKEN_KEYS: JSON.stringify([key]) }).ACCESS_TOKEN_KEYS,
      ).toEqual([key]);
    });
  });
});
