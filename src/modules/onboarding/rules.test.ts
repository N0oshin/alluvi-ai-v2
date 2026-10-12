import { describe, expect, it } from 'vitest';
import {
  ageInYears,
  birthDateProblem,
  EARLIEST_BIRTH_DATE,
  missingAnswers,
  REQUIRED_ANSWERS,
  roundTo,
  targetWeightMatchesGoal,
} from './rules.js';

describe('targetWeightMatchesGoal', () => {
  // goal, current weight, target weight, expected
  const table = [
    ['lose', 72.6, 65.0, true],
    ['lose', 72.6, 72.5, true],
    ['lose', 72.6, 72.6, false],
    ['lose', 72.6, 80.0, false],
    ['gain', 55.0, 62.0, true],
    ['gain', 55.0, 55.1, true],
    ['gain', 55.0, 55.0, false],
    ['gain', 55.0, 50.0, false],
    ['maintain', 60.0, 60.0, true],
    ['maintain', 60.0, 59.9, false],
    ['maintain', 60.0, 60.1, false],
  ] as const;

  it.each(table)('%s at %f kg with a target of %f kg is %s', (goal, weight, target, expected) => {
    expect(targetWeightMatchesGoal(goal, weight, target)).toBe(expected);
  });
});

describe('birthDateProblem', () => {
  const today = '2026-10-12';

  it.each([
    ['1998-03-14', null],
    [EARLIEST_BIRTH_DATE, null],
    ['2026-10-12', null],
    ['2025-06-01', null], // no minimum age
    ['1899-12-31', 'too_early'],
    ['2026-10-13', 'in_future'],
    ['2099-01-01', 'in_future'],
  ] as const)('%s is %s', (birthDate, expected) => {
    expect(birthDateProblem(birthDate, today)).toBe(expected);
  });
});

describe('roundTo', () => {
  it('rounds to the given number of decimals', () => {
    expect(roundTo(72.64, 1)).toBe(72.6);
    expect(roundTo(72.66, 1)).toBe(72.7);
    expect(roundTo(170.126, 2)).toBe(170.13);
    expect(roundTo(60, 1)).toBe(60);
  });
});

describe('missingAnswers', () => {
  const complete = {
    sex: 'female',
    workoutFrequency: '3_5',
    birthDate: '1998-03-14',
    unitSystem: 'metric',
    heightCm: 170.2,
    weightKg: 72.6,
    targetWeightKg: 65,
    goal: 'lose',
  } as const;
  const empty = {
    sex: null,
    workoutFrequency: null,
    birthDate: null,
    unitSystem: null,
    heightCm: null,
    weightKg: null,
    targetWeightKg: null,
    goal: null,
  } as const;

  it('names all eight required answers, in screen order, when nothing is answered', () => {
    expect(missingAnswers(empty)).toEqual([
      'sex',
      'workoutFrequency',
      'birthDate',
      'unitSystem',
      'heightCm',
      'weightKg',
      'targetWeightKg',
      'goal',
    ]);
    expect(REQUIRED_ANSWERS).toHaveLength(8);
  });

  it('is empty when every required answer is present', () => {
    expect(missingAnswers(complete)).toEqual([]);
  });

  it('lists only the ones still empty', () => {
    expect(missingAnswers({ ...complete, goal: null, heightCm: null })).toEqual([
      'heightCm',
      'goal',
    ]);
  });
});

describe('ageInYears', () => {
  const on = new Date('2026-10-12T12:00:00Z');

  it.each([
    ['1998-10-12', 28], // birthday today: already 28
    ['1998-10-13', 27], // birthday tomorrow: still 27
    ['1998-10-11', 28],
    ['2008-10-12', 18], // 18 exactly
    ['2008-10-13', 17], // one day short of 18
    ['1998-03-14', 28],
    ['1998-12-31', 27],
    ['2026-10-12', 0], // born today
  ] as const)('born %s is %i on 2026-10-12', (birthDate, expected) => {
    expect(ageInYears(birthDate, on)).toBe(expected);
  });

  it('counts a 29 February birthday from 1 March in a non-leap year', () => {
    expect(ageInYears('2000-02-29', new Date('2027-02-28T12:00:00Z'))).toBe(26);
    expect(ageInYears('2000-02-29', new Date('2027-03-01T12:00:00Z'))).toBe(27);
  });

  it('reads the date in UTC, so the server time zone does not change the age', () => {
    // 23:30 UTC on the 11th is still the 11th, whatever the local clock says.
    expect(ageInYears('1998-10-12', new Date('2026-10-11T23:30:00Z'))).toBe(27);
    expect(ageInYears('1998-10-12', new Date('2026-10-12T00:30:00Z'))).toBe(28);
  });
});
