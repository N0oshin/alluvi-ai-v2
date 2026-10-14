//
//   guest-sessions.ts   POST /v1/guest-sessions
//   sessions.ts         POST /v1/auth/token/refresh, POST /v1/auth/logout
//   magic-links.ts      POST /v1/auth/email/magic-links, .../open, .../{id}/claim,
//                       and the browser page at MAGIC_LINK_BASE_URL
//   magic-link-email.ts the email those links are sent in
//   magic-link-page.ts  the HTML of that browser page
//   social-sign-in.ts   POST /v1/auth/apple, POST /v1/auth/google
//   shared.ts           install id, consents and device lookup used by all
//   sign-in.ts          the rules shared by every sign-in method (no routes)

export { guestSessionRoutes } from './guest-sessions.js';
export { sessionRoutes } from './sessions.js';
export { magicLinkPageRoutes, magicLinkRoutes } from './magic-links.js';
export { socialSignInRoutes, type IdentityTokenVerifiers } from './social-sign-in.js';
export { createSignInService } from './sign-in.js';
