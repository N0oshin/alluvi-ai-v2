import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../../shared/schema.js';

const instant = () => timestamp({ withTimezone: true });

// Addresses we must stop emailing: the email provider told us (through its
// webhook) that mail to them bounced or was reported as spam. One row per
// address, kept up to date with the latest event. Checked before any email
// is sent (decision 39).
export const emailSuppressions = pgTable(
  'email_suppressions',
  {
    ...baseColumns,
    // Lower-cased.
    email: text().notNull(),
    reason: text().notNull(),
    // The provider's id for the event, for tracing in its dashboard.
    providerEventId: text(),
    lastEventAt: instant().notNull(),
  },
  (table) => [
    uniqueIndex('email_suppressions_email').on(table.email),
    check('email_suppressions_reason', sql`${table.reason} in ('bounce', 'complaint')`),
    check('email_suppressions_email_lowercase', sql`${table.email} = lower(${table.email})`),
  ],
);
