// Addresses we must not email, on the `email_suppressions` table.
// Written by the Resend webhook, read before every send.

import { eq } from 'drizzle-orm';
import type { Executor } from './idempotency-store.js';
import { emailSuppressions } from './schema/index.js';

export type SuppressionReason = 'bounce' | 'complaint';

export interface SuppressionEvent {
  email: string;
  reason: SuppressionReason;
  providerEventId: string | null;
  at: Date;
}

export interface EmailSuppressionStore {
  // Records the event; a second event for the same address updates the row.
  suppress(event: SuppressionEvent): Promise<void>;
  isSuppressed(email: string): Promise<boolean>;
}

export function createEmailSuppressionStore(db: Executor): EmailSuppressionStore {
  return {
    async suppress(event) {
      const email = event.email.trim().toLowerCase();
      await db
        .insert(emailSuppressions)
        .values({
          email,
          reason: event.reason,
          providerEventId: event.providerEventId,
          lastEventAt: event.at,
        })
        // Same upsert as the device store (backend notes, entry 42).
        .onConflictDoUpdate({
          target: emailSuppressions.email,
          set: {
            reason: event.reason,
            providerEventId: event.providerEventId,
            lastEventAt: event.at,
            updatedAt: event.at,
          },
        });
    },

    async isSuppressed(email) {
      const row = await db.query.emailSuppressions.findFirst({
        where: eq(emailSuppressions.email, email.trim().toLowerCase()),
        columns: { id: true },
      });
      return row !== undefined;
    },
  };
}

export function memoryEmailSuppressionStore(): EmailSuppressionStore & {
  readonly suppressed: Map<string, SuppressionEvent>;
} {
  const suppressed = new Map<string, SuppressionEvent>();
  return {
    suppressed,
    suppress(event) {
      suppressed.set(event.email.trim().toLowerCase(), event);
      return Promise.resolve();
    },
    isSuppressed(email) {
      return Promise.resolve(suppressed.has(email.trim().toLowerCase()));
    },
  };
}
