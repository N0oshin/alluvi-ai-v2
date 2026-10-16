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

// limit	Number of data items to return. Must be between 1 and 100, defaults to 20.
//cursor	Text length of the token.
export const paginationFields = {
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().min(1).max(1024).optional(),
};

// defines the exact shape and structure of the JSON response your server sends back to the client whenever they request a paginated list.
//• <T>: This is a TypeScript Generic (a placeholder type). It means this pagination structure is reusable for anything.
// If you are paginating a list of Users, it becomes Page<User>.
// If you are paginating a list of Products, it becomes Page<Product>.

export interface Page<T> {
  data: T[];
  page: {
    next_cursor: string | null;
    has_more: boolean;
  };
}

export function encodeCursor(position: unknown): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

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
