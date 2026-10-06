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
    expect(loadConfig({ ...valid, NODE_ENV: 'production' }).LOG_LEVEL).toBe('info');
    expect(loadConfig({ ...valid, LOG_LEVEL: 'warn' }).LOG_LEVEL).toBe('warn');
  });

  it('rejects an unknown LOG_LEVEL and names it', () => {
    expect(() => loadConfig({ ...valid, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
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
});
