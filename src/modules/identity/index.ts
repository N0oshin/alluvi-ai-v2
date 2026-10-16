// Identity: devices, guest sessions, accounts, sessions and sign-in.
//
//   schema.ts       users, auth_identities, devices, sessions, guest_sessions,
//                   magic_link_tokens, user_consents
//   queries.ts      every database call, grouped by table
//   sign-in.ts      the rules shared by every sign-in method
//   routes.ts       the HTTP routes and the magic link browser page
//   magic-link.ts   the email a magic link is sent in and the page it opens
//   jobs.ts         identity.purge
//
// What other code may use is below; nothing else in this folder is imported
// from outside it.

export { identityRoutes, magicLinkPageRoutes } from './routes.js';
export { identityJobs } from './jobs.js';
// The auth middleware resolves guest tokens through this.
export { resolveGuestSession } from './queries.js';
export type { SignInBody } from './sign-in.js';
