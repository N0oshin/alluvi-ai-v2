// The `email_suppressions` table: written by the provider webhook, read
// before every send.

import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { emailSuppressions } from './schema.js';

export type SuppressionReason = 'bounce' | 'complaint';

export interface SuppressionEvent {
  email: string;
  reason: SuppressionReason;
  providerEventId: string | null;
  at: Date;
}

// Records the event; a second event for the same address updates the row.
export async function suppressEmail(event: SuppressionEvent): Promise<void> {
  const email = event.email.trim().toLowerCase();
  await db
    .insert(emailSuppressions)
    .values({
      email,
      reason: event.reason,
      providerEventId: event.providerEventId,
      lastEventAt: event.at,
    })
    .onConflictDoUpdate({
      target: emailSuppressions.email,
      set: {
        reason: event.reason,
        providerEventId: event.providerEventId,
        lastEventAt: event.at,
        updatedAt: event.at,
      },
    });
}

export async function isEmailSuppressed(email: string): Promise<boolean> {
  const row = await db.query.emailSuppressions.findFirst({
    where: eq(emailSuppressions.email, email.trim().toLowerCase()),
    columns: { id: true },
  });
  return row !== undefined;
}
