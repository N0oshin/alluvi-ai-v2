import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app.js';
import type { ErrorDetail } from './errors.js';
import {
  buildPage,
  decodeCursor,
  encodeCursor,
  paginationFields,
  type Page,
} from './pagination.js';
import { validate } from './validate.js';

const deps = { checkDatabase: () => Promise.resolve() };

interface ErrorBody {
  error: { code: string; details: ErrorDetail[] };
}

interface Item {
  id: number;
}

// 45 items with ids 1 to 45, standing in for a database table.
const items: Item[] = Array.from({ length: 45 }, (_unused, index) => ({ id: index + 1 }));

const querySchema = z.strictObject({ ...paginationFields });
const cursorSchema = z.strictObject({ id: z.number().int() });

// Builds the app with one list route that pages through `items` by id.
function buildTestApp() {
  const app = buildApp(deps);
  app.get('/items', (request) => {
    const query = validate(querySchema, request.query);
    const after = query.cursor ? decodeCursor(query.cursor, cursorSchema) : undefined;

    // What a database query will do later: skip to the cursor, read limit + 1.
    const rows = items
      .filter((item) => after === undefined || item.id > after.id)
      .slice(0, query.limit + 1);

    return buildPage(rows, query.limit, (last) => ({ id: last.id }));
  });
  return app;
}

async function get(url: string) {
  const app = buildTestApp();
  const response = await app.inject({ method: 'GET', url });
  await app.close();
  return response;
}

describe('cursor encoding', () => {
  it('decodes what it encoded', () => {
    const cursor = encodeCursor({ id: 7 });

    expect(decodeCursor(cursor, cursorSchema)).toEqual({ id: 7 });
  });

  it('produces a string that is safe in a URL', () => {
    const cursor = encodeCursor({ logged_at: '2026-09-18T14:55:00Z', id: '0191??>>' });

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('buildPage', () => {
  it('reports more pages when it receives limit + 1 rows', () => {
    const page = buildPage([{ id: 1 }, { id: 2 }, { id: 3 }], 2, (last) => ({ id: last.id }));

    expect(page.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(page.page.has_more).toBe(true);
    expect(page.page.next_cursor).toBe(encodeCursor({ id: 2 }));
  });

  it('reports the last page when it receives limit rows or fewer', () => {
    const page = buildPage([{ id: 1 }, { id: 2 }], 2, (last) => ({ id: last.id }));

    expect(page).toEqual({
      data: [{ id: 1 }, { id: 2 }],
      page: { next_cursor: null, has_more: false },
    });
  });

  it('handles an empty list', () => {
    const page = buildPage([], 20, () => ({}));

    expect(page).toEqual({ data: [], page: { next_cursor: null, has_more: false } });
  });
});

describe('a paginated route', () => {
  it('uses a page size of 20 by default', async () => {
    const response = await get('/items');
    const body = response.json<Page<Item>>();

    expect(response.statusCode).toBe(200);
    expect(body.data).toHaveLength(20);
    expect(body.page.has_more).toBe(true);
  });

  it('walks through every item exactly once', async () => {
    const seen: number[] = [];
    let url = '/items?limit=20';

    // 45 items at 20 per page: three pages. The loop bound only stops a
    // broken helper from looping forever.
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const body = (await get(url)).json<Page<Item>>();
      seen.push(...body.data.map((item) => item.id));

      if (body.page.next_cursor === null) {
        break;
      }
      url = `/items?limit=20&cursor=${body.page.next_cursor}`;
    }

    expect(seen).toEqual(items.map((item) => item.id));
  });

  it('rejects a limit above 100', async () => {
    const response = await get('/items?limit=101');

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details[0]).toMatchObject({
      field: 'limit',
      code: 'out_of_range',
    });
  });

  it('rejects a limit that is not a number', async () => {
    const response = await get('/items?limit=many');

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details[0]).toMatchObject({ field: 'limit' });
  });

  it('rejects a cursor that is not one of ours', async () => {
    const response = await get('/items?cursor=not-a-cursor');

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details).toEqual([
      { field: 'cursor', code: 'invalid', message: 'The cursor is not valid.' },
    ]);
  });

  it('rejects a cursor with the wrong content', async () => {
    const response = await get(`/items?cursor=${encodeCursor({ id: 'abc' })}`);

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details[0]).toMatchObject({ field: 'cursor' });
  });

  it('rejects an unknown query parameter', async () => {
    const response = await get('/items?offset=40');

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details[0]).toMatchObject({
      field: 'offset',
      code: 'unknown_field',
    });
  });
});
