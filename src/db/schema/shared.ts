// Column helpers shared by every table.

import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Every instant is stored as `timestamp with time zone` (timestamptz).
// PostgreSQL keeps it in UTC and Drizzle hands it to the app as a JS Date.
const instant = () => timestamp({ withTimezone: true });

// Primary key: a UUID v7, generated in Node when a row is inserted, so the id is known before the insert
export const id = {
  id: uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7()),
};

// `created_at` is set by the database (`DEFAULT now()`), so it is right even
// for rows inserted outside the app.
export const timestamps = {
  createdAt: instant().defaultNow().notNull(),
  updatedAt: instant()
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};

// Soft delete for user-generated content (meals, messages, groups): the row
// stays, `deleted_at` is set, and every query filters it out. NULL means live.
export const softDelete = {
  deletedAt: instant(),
};

// The columns every table has.
export const baseColumns = {
  ...id,
  ...timestamps,
};
