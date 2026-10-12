// Only `record` exists. There is no update and no delete on purpose: an
// audit trail that code can edit is not one.

import type { Executor } from './idempotency-store.js';
import { auditLog } from './schema/index.js';

// The actions written so far. Later phases add theirs here, so the list of
// everything the log can contain is in one place.
export const AUDIT_ACTIONS = {
  signIn: 'auth.sign_in',
  signUp: 'auth.sign_up',
  signInFailed: 'auth.sign_in_failed',
  logout: 'auth.logout',
  refreshReuse: 'auth.refresh_token_reuse',
  consentRecorded: 'consent.recorded',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  action: AuditAction;
  actorUserId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  deviceId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditStore {
  record(entry: AuditEntry): Promise<void>;
}

export function createAuditStore(db: Executor): AuditStore {
  return {
    async record(entry) {
      await db.insert(auditLog).values({
        action: entry.action,
        actorUserId: entry.actorUserId ?? null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        deviceId: entry.deviceId ?? null,
        requestId: entry.requestId ?? null,
        ip: entry.ip ?? null,
        metadata: entry.metadata ?? {},
      });
    },
  };
}

// For tests: keeps the entries in an array you can read.
export function memoryAuditStore(): AuditStore & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
      return Promise.resolve();
    },
  };
}

// Writes an entry without letting a failure of the log break the request.
// A sign-in that worked must not turn into a 500 because the audit table
// was briefly unreachable; the failure is logged instead, where it can be
// alerted on. [A]
export async function recordAudit(
  store: AuditStore,
  entry: AuditEntry,
  log: { error: (object: object, message: string) => void },
): Promise<void> {
  try {
    await store.record(entry);
  } catch (error) {
    log.error({ err: error, action: entry.action }, 'audit entry could not be written');
  }
}
