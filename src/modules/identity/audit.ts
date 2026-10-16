// Audit entries for the sign-in routes (document 03 section 5: sign-ins,
// failed sign-ins, consent changes).
//
// The three sign-in routes (Apple, Google, magic link claim) each end the
// same way: either a signed-in result, or an AppError. This wraps that
// ending once, so each route adds three lines instead of its own try/catch:
//
//   return withSignInAudit(deps.audit, request, 'google', async () => {
//     ... the route's steps ...
//     return { result, deviceId, consents };
//   });
//
// The magic link open route (the browser page's confirm) is not a sign-in,
// but a bad token presented there is still someone guessing, so it records
// the failure with `auditSignInFailure` on its own.

import type { FastifyRequest } from 'fastify';
import type { AuthProvider, ConsentDecision } from '../../db/account-store.js';
import { AUDIT_ACTIONS, recordAudit, type AuditStore } from '../../db/audit-store.js';
import { AppError, type ErrorCode } from '../../shared/http/errors.js';
import type { SignInResult } from './sign-in.js';

// The refusals that count as a failed sign-in. Left out on purpose:
// validation_failed and invalid_email (a bug in the app, not someone
// guessing), service_unavailable (our fault), and rate_limited (refused
// before the handler runs, so it never reaches this code).
const SIGN_IN_FAILURES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'unauthenticated',
  'invalid_identity_token',
  'magic_link_invalid',
  'magic_link_expired',
  'magic_link_already_used',
  'account_suspended',
  'email_linked_to_other_provider',
  'consent_required',
]);

export interface SignInOutcome {
  result: SignInResult;
  deviceId: string;
  // What the person ticked; recorded when the call created the account.
  consents: ConsentDecision[];
}

// Writes auth.sign_in_failed when `error` is one of the refusals above;
// anything else is left alone. Resolves either way; the caller rethrows.
export async function auditSignInFailure(
  audit: AuditStore,
  request: FastifyRequest,
  provider: AuthProvider,
  error: unknown,
): Promise<void> {
  if (!(error instanceof AppError) || !SIGN_IN_FAILURES.has(error.code)) return;
  await recordAudit(
    audit,
    {
      action: AUDIT_ACTIONS.signInFailed,
      requestId: request.id,
      ip: request.ip,
      metadata: { provider, code: error.code },
    },
    request.log,
  );
}

export async function withSignInAudit(
  audit: AuditStore,
  request: FastifyRequest,
  provider: AuthProvider,
  run: () => Promise<SignInOutcome>,
): Promise<SignInResult> {
  const where = { requestId: request.id, ip: request.ip };

  let outcome: SignInOutcome;
  try {
    outcome = await run();
  } catch (error) {
    await auditSignInFailure(audit, request, provider, error);
    throw error;
  }

  const { result, deviceId, consents } = outcome;
  const actorUserId = result.body.user.id;
  const created = result.status === 201;

  await recordAudit(
    audit,
    {
      action: created ? AUDIT_ACTIONS.signUp : AUDIT_ACTIONS.signIn,
      actorUserId,
      deviceId,
      ...where,
      metadata: { provider },
    },
    request.log,
  );

  // Consents are written only when the account is created, so that is the
  // only time there is a decision to record.
  if (created) {
    await recordAudit(
      audit,
      {
        action: AUDIT_ACTIONS.consentRecorded,
        actorUserId,
        deviceId,
        ...where,
        metadata: {
          consents: consents.map((c) => ({
            type: c.type,
            version: c.documentVersion,
            granted: c.granted,
          })),
        },
      },
      request.log,
    );
  }

  return result;
}
