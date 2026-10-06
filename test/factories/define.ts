// `defineFactory`: the one pattern every test data factory follows.
//
// A factory knows how to produce a valid row for one table. A test asks for a
// row and states only the facts it cares about; the factory fills in the rest
// with plausible values:
//
//   const event = await factories.outboxEvent.create({ eventType: 'meal.changed' });
//
// Two methods per factory:
//   build(overrides)   returns the insert object, touches no database. For unit tests.
//   create(overrides)  inserts it into the test database and returns the saved row.
//
// Rule for the project (backend notes, entry 28): every table gets a factory in
// the phase that creates it, in test/factories/<context>.ts, so no test ever
// writes a raw insert with every column spelled out.

import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { testDb } from '../db.js';

export interface Factory<TTable extends PgTable> {
  build(overrides?: Partial<InferInsertModel<TTable>>): InferInsertModel<TTable>;
  create(overrides?: Partial<InferInsertModel<TTable>>): Promise<InferSelectModel<TTable>>;
}

// `defaults` is a function, not an object, so each call produces fresh values
// (a new id, a new timestamp, a different counter). `InferInsertModel` is the
// type Drizzle derives for an insert into this table: required columns
// required, columns with a default optional (TypeScript notes, entry 28).
export function defineFactory<TTable extends PgTable>(
  table: TTable,
  defaults: () => InferInsertModel<TTable>,
): Factory<TTable> {
  return {
    build(overrides = {}) {
      return { ...defaults(), ...overrides };
    },
    async create(overrides = {}) {
      const rows = await testDb().insert(table).values(this.build(overrides)).returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error('insert returned no row');
      }
      return row as InferSelectModel<TTable>;
    },
  };
}

// A counter for values that must differ between rows, such as names.
let sequence = 0;
export function nextSequence(): number {
  sequence += 1;
  return sequence;
}
