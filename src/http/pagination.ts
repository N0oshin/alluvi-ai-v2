// Cursor pagination. A list endpoint returns one
// page at a time:
//
//   { "data": [...], "page": { "next_cursor": "b3BhcXVl", "has_more": true } }
//
// The client sends `next_cursor` back as `?cursor=` to get the following page.
// A route uses the three pieces of this file like this:
//
//   const query = validate(z.strictObject({ ...paginationFields }), request.query);
//   const after = query.cursor ? decodeCursor(query.cursor, cursorSchema) : undefined;
//   const rows = ...read query.limit + 1 rows that come after `after`...
//   return buildPage(rows, query.limit, (last) => ({ id: last.id }));
//
// The database part (the WHERE clause that skips to the cursor) is written in
// each list endpoint, from Phase 1.4 on. See docs/backend-notes.md entry 16.

import { z } from 'zod';
import { AppError } from './errors.js';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

// The two query parameters every list endpoint accepts. They are spread into
// the route's own schema, next to its other parameters:
//   z.strictObject({ ...paginationFields, saved: z.boolean().optional() })
export const paginationFields = {
  // Query values always arrive as strings; z.coerce turns "50" into 50.
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().min(1).max(1024).optional(),
};

// The list envelope. <T> is the type of one item; see
// docs/typescript-notes.md entry 22.
export interface Page<T> {
  data: T[];
  page: {
    // null on the last page.
    next_cursor: string | null;
    has_more: boolean;
  };
}

// Turns a position in a list (for example { logged_at, id } of the last item
// sent) into the opaque string the client sees: JSON, then base64url, which
// is base64 using only characters that are safe inside a URL.
export function encodeCursor(position: unknown): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

// The reverse of encodeCursor. A cursor comes from the client, so it is
// treated like any other input: `schema` says what a position must look like,
// and anything else is answered as 422 with the field `cursor`.
export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  let position: unknown;
  try {
    position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  const result = schema.safeParse(position);
  if (!result.success) {
    throw invalidCursor();
  }
  return result.data;
}

function invalidCursor(): AppError {
  return new AppError('validation_failed', [
    { field: 'cursor', code: 'invalid', message: 'The cursor is not valid.' },
  ]);
}

// Builds the envelope. The caller reads `limit + 1` rows: the extra row is
// never sent, it only proves that another page exists.
// `positionOf` picks the cursor position out of the last item of the page.
export function buildPage<T>(rows: T[], limit: number, positionOf: (last: T) => unknown): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);

  return {
    data,
    page: {
      next_cursor: hasMore && last !== undefined ? encodeCursor(positionOf(last)) : null,
      has_more: hasMore,
    },
  };
}
