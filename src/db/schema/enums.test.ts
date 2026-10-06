import { isPgEnum } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as enums from './enums.js';
import * as schema from './index.js';

// Every exported value that is a Drizzle enum.
const all = Object.values(enums).filter(isPgEnum);

describe('enumerations', () => {
  it('defines the 29 enums of document 01 section 5', () => {
    expect(all).toHaveLength(29);
  });

  it('uses snake_case type names and values', () => {
    for (const e of all) {
      expect(e.enumName).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const value of e.enumValues) {
        expect(value).toMatch(/^[a-z0-9][a-z0-9_]*$/);
      }
    }
  });

  it('has no duplicate type names or duplicate values within a type', () => {
    const names = all.map((e) => e.enumName);
    expect(new Set(names).size).toBe(names.length);
    for (const e of all) {
      expect(new Set(e.enumValues).size).toBe(e.enumValues.length);
    }
  });

  it('spells the values as document 01 does', () => {
    expect(enums.userStatusEnum.enumValues).toEqual([
      'active',
      'suspended',
      'pending_deletion',
      'deleted',
    ]);
    expect(enums.workoutFrequencyEnum.enumValues).toEqual(['0_2', '3_5', '6_plus']);
    expect(enums.fastingProtocolEnum.enumValues).toEqual(['12_12', '14_10', '16_8', 'custom']);
    expect(enums.scanStatusEnum.enumValues).toEqual([
      'created',
      'uploading',
      'queued',
      'analyzing',
      'finalizing',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('is re-exported by the schema barrel', () => {
    expect(Object.values(schema).filter(isPgEnum)).toHaveLength(29);
  });
});
