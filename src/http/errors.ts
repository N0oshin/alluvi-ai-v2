// The error code registry and the error class (document 02 sections 1.2
// and 1.3).
//
// Every error the API returns has a `code` from this list. The phone app
// branches on the code, so a code is never renamed once it is in use.
// Endpoint-specific codes are added here as their phases arrive.

// `as const` is explained in docs/typescript-notes.md entry 18.
export const ERROR_CODES = {
  malformed_request: { status: 400, message: 'The request could not be read.' },
  unauthenticated: { status: 401, message: 'Sign in to continue.' },
  // A rotated refresh token was presented again; the session has been revoked
  // (document 02 section 4.4, backend notes entry 39).
  refresh_token_reused: { status: 401, message: 'Your session has ended. Sign in again.' },
  // Unknown or malformed magic link token (document 02 section 4.3).
  magic_link_invalid: { status: 401, message: 'This link is not valid.' },
  // Apple or Google identity token failed signature, audience, nonce or
  // expiry (document 02 section 4.1).
  invalid_identity_token: { status: 401, message: 'Sign-in could not be verified. Try again.' },
  forbidden: { status: 403, message: 'You are not allowed to do this.' },
  account_suspended: { status: 403, message: 'This account has been suspended.' },
  not_found: { status: 404, message: 'The resource was not found.' },
  // Magic link requested with intent sign_in for an address with no account
  // (document 02 section 4.2, screen 128; decision 35).
  account_not_found: { status: 404, message: 'There is no account for this email address.' },
  conflict: { status: 409, message: 'The request conflicts with the current state.' },
  email_linked_to_other_provider: {
    status: 409,
    message: 'This email is already linked to an account that signs in another way.',
  },
  // Magic link consumption (document 02 section 4.3).
  magic_link_already_used: { status: 409, message: 'This link has already been used.' },
  // The link was opened on a different install than requested it; the app
  // asks the person to confirm and retries with confirm_device: true.
  magic_link_other_device: {
    status: 409,
    message: 'This link was requested from a different device.',
  },
  magic_link_expired: { status: 410, message: 'This link has expired. Request a new one.' },
  precondition_failed: { status: 412, message: 'The resource was changed by someone else.' },
  payload_too_large: { status: 413, message: 'The request is too large.' },
  unsupported_media_type: { status: 415, message: 'The content type is not supported.' },
  validation_failed: { status: 422, message: 'One or more fields are invalid.' },
  invalid_email: { status: 422, message: 'Enter a valid email address.' },
  // `terms_and_privacy` consent missing or not granted on account creation.
  consent_required: {
    status: 422,
    message: 'You must accept the Terms and Conditions and Privacy Policy.',
  },
  idempotency_key_reused: {
    status: 422,
    message: 'This Idempotency-Key was already used for a different request.',
  },
  upgrade_required: { status: 426, message: 'Update the app to continue.' },
  rate_limited: { status: 429, message: 'Too many requests. Try again later.' },
  internal_error: { status: 500, message: 'Something went wrong on our side.' },
  service_unavailable: { status: 503, message: 'The service is temporarily unavailable.' },
} as const;

// The type of a valid code: 'malformed_request' | 'unauthenticated' | ...
// Built from the keys of the object above, so the two cannot drift apart.
export type ErrorCode = keyof typeof ERROR_CODES;

// One entry of `details`: which field is wrong and why. Filled in by the
// validation layer.
export interface ErrorDetail {
  field: string;
  code: string;
  message: string;
}

// The error that application code throws to stop a request with a known
// outcome, for example: throw new AppError('not_found');
// The class syntax is explained in docs/typescript-notes.md entry 19.
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetail[];

  constructor(code: ErrorCode, details: ErrorDetail[] = []) {
    // Error's own constructor takes the message.
    super(ERROR_CODES[code].message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}
