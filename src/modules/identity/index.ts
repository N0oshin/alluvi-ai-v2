//
//   guest-sessions.ts   POST /v1/guest-sessions
//   sessions.ts         POST /v1/auth/token/refresh, POST /v1/auth/logout
//   magic-links.ts      POST /v1/auth/email/magic-links, .../consume
//   magic-link-email.ts the email those links are sent in
//   social-sign-in.ts   POST /v1/auth/apple, POST /v1/auth/google
//   shared.ts           install id, consents and device lookup used by all
//   sign-in.ts          the rules shared by every sign-in method (no routes)

export { guestSessionRoutes } from './guest-sessions.js';
export { sessionRoutes } from './sessions.js';
export { magicLinkRoutes } from './magic-links.js';
export { socialSignInRoutes, type IdentityTokenVerifiers } from './social-sign-in.js';
export { createSignInService } from './sign-in.js';
