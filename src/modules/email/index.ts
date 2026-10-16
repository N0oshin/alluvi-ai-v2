// Email: which addresses we may not write to, and the provider webhook that
// tells us.
//
//   schema.ts    email_suppressions
//   queries.ts   suppress an address, check an address
//   routes.ts    POST /webhooks/resend

export { webhookRoutes } from './routes.js';
// Checked by any module before it sends an email.
export { isEmailSuppressed } from './queries.js';
