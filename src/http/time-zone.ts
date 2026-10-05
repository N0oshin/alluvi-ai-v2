// The app sends the phone's time zone on every request:
//
//   X-Time-Zone: Europe/London
//
// The server stores instants in UTC, but a "day" in this app is the user's own
// calendar day: a meal logged at 23:30 in London and the same instant seen
// from Tokyo fall on different dates. A route that needs the user's day uses
// this file like this:
//
//   const timeZone = readTimeZone(request.headers);
//   const today = localDateIn(timeZone);            // '2026-09-18'
//
// and a schema that accepts a day from the client uses `localDateField`.

import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import { AppError } from './errors.js';

const MAX_TIME_ZONE_LENGTH = 64;

// Returns the zone's official spelling ('europe/london' -> 'Europe/London'),
// or undefined when it is not a known IANA zone. A zone with two names may
// come back under the other one ('America/Argentina/Buenos_Aires' ->
// 'America/Buenos_Aires'); both follow the same rules.
export function canonicalTimeZone(value: string): string | undefined {
  // Intl also accepts offsets ('+01:00') and old abbreviations ('EST'). Those
  // do not follow daylight saving, so only 'Area/City' names and 'UTC' pass.
  if (value.length > MAX_TIME_ZONE_LENGTH || (!value.includes('/') && value !== 'UTC')) {
    return undefined;
  }

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

// Reads X-Time-Zone from the request headers. A missing or unknown zone is a
// 422 on the field 'X-Time-Zone', in the same shape as a body validation error.
export function readTimeZone(headers: IncomingHttpHeaders): string {
  const value = headers['x-time-zone'];

  if (value === undefined) {
    throw new AppError('validation_failed', [
      { field: 'X-Time-Zone', code: 'required', message: 'This header is required.' },
    ]);
  }

  // A header sent twice arrives as an array; that is refused as well.
  const timeZone = typeof value === 'string' ? canonicalTimeZone(value.trim()) : undefined;
  if (timeZone === undefined) {
    throw new AppError('validation_failed', [
      { field: 'X-Time-Zone', code: 'invalid', message: 'Must be an IANA time zone name.' },
    ]);
  }
  return timeZone;
}

// The calendar date ('YYYY-MM-DD') that `instant` falls on in `timeZone`.
// `instant` defaults to now. Intl applies the zone's rules, daylight saving
// included; the 'en-CA' locale is used only because it writes dates as
// year-month-day.
export function localDateIn(timeZone: string, instant: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export const localDateField = z.iso.date();
