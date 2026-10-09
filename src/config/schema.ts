//
// Every environment variable the backend reads is described once in the schema
// below. This file has no side effects (it does not touch process.env), so
// tests can import it and call loadConfig with any input. The real config is
// built in ./index.ts.

import { z } from 'zod';
import { parseAccessTokenKeys } from '../auth/keys.js';
import { LOG_LEVELS } from '../http/logging.js';

// The allowed names for each external service provider (src/providers/).
// 'fake' needs no key and is the default outside production, so a fresh
// clone starts without any vendor account.
export const FOOD_VISION_PROVIDERS = ['fake', 'snapcalorie', 'gemini'] as const;
export const EMAIL_PROVIDERS = ['fake', 'resend'] as const;
export const PUSH_PROVIDERS = ['fake', 'fcm'] as const;
export const STORAGE_PROVIDERS = ['fake', 's3'] as const;
const PROVIDER_VARIABLES = [
  'FOOD_VISION_PROVIDER',
  'EMAIL_PROVIDER',
  'PUSH_PROVIDER',
  'STORAGE_PROVIDER',
] as const;

// "a, b ,c" -> ['a', 'b', 'c']; unset stays undefined; blanks are dropped.
const commaList = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined
      ? undefined
      : value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
  );

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Environment variables are always strings; z.coerce turns "3000" into 3000.
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // The database the automated tests truncate and fill. Optional: without it
  // the tests that need a database are skipped. Until production exists it
  // may be the same value as DATABASE_URL (decided 2026-10-06); a separate
  // database is a Phase 13 launch item. See test/db.ts.
  TEST_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  // How much the app writes to its log. Optional: the default depends on
  // NODE_ENV and is filled in below.
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  // Where a magic link points. The token is appended as ?token=mlt_... and
  // the app claims this URL as a Universal Link / App Link (Phase 2.3) so
  // tapping it opens the app. The default is a placeholder for development.
  MAGIC_LINK_BASE_URL: z.url().default('https://app.alluvi.ai/auth/magic-link'),
  // The client ids an Apple / Google identity token may be issued for (its
  // `aud`), comma separated: the iOS bundle id, the Android client id, and
  // so on. Optional outside production: unset, the route answers 503.
  APPLE_CLIENT_IDS: commaList,
  GOOGLE_CLIENT_IDS: commaList,
  FOOD_VISION_PROVIDER: z.enum(FOOD_VISION_PROVIDERS).default('fake'),
  EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).default('fake'),
  // Resend (EMAIL_PROVIDER=resend). The key from the Resend dashboard, and
  // the From header, e.g. "Alluvi AI <hello@alluvi.ai>", on a domain
  // verified there. Both required when resend is selected.
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(3).max(320).optional(),
  PUSH_PROVIDER: z.enum(PUSH_PROVIDERS).default('fake'),
  STORAGE_PROVIDER: z.enum(STORAGE_PROVIDERS).default('fake'),
  // The access token signing keys as a JSON array (src/auth/keys.ts). The
  // string from the environment is turned into the parsed list here, so the
  // rest of the app never sees the raw JSON. Optional outside production:
  // without it the server makes a key at start-up (src/server.ts).
  ACCESS_TOKEN_KEYS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      try {
        return parseAccessTokenKeys(value);
      } catch (error) {
        ctx.issues.push({
          code: 'custom',
          message: error instanceof Error ? error.message : 'invalid',
          input: value,
        });
        return z.NEVER;
      }
    }),
});

// Detailed in development, nothing in tests, the useful lines in production.
function defaultLogLevel(nodeEnv: 'development' | 'test' | 'production') {
  switch (nodeEnv) {
    case 'development':
      return 'debug' as const;
    case 'test':
      return 'silent' as const;
    case 'production':
      return 'info' as const;
  }
}

// `...data` copies every validated field; LOG_LEVEL is then set for sure.
const schema = rawSchema
  .transform((data) => ({
    ...data,
    LOG_LEVEL: data.LOG_LEVEL ?? defaultLogLevel(data.NODE_ENV),
  }))
  .check((ctx) => {
    // A vendor's settings are required as soon as that vendor is chosen, in
    // any environment: choosing resend without a key fails at start-up, not
    // at the first magic link.
    if (ctx.value.EMAIL_PROVIDER === 'resend') {
      for (const variable of ['RESEND_API_KEY', 'EMAIL_FROM'] as const) {
        if (ctx.value[variable] === undefined) {
          ctx.issues.push({
            code: 'custom',
            message: 'is required when EMAIL_PROVIDER=resend',
            input: undefined,
            path: [variable],
          });
        }
      }
    }

    if (ctx.value.NODE_ENV !== 'production') return;
    if (ctx.value.ACCESS_TOKEN_KEYS === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'is required in production',
        input: undefined,
        path: ['ACCESS_TOKEN_KEYS'],
      });
    }
    for (const variable of ['APPLE_CLIENT_IDS', 'GOOGLE_CLIENT_IDS'] as const) {
      if (ctx.value[variable] === undefined || ctx.value[variable].length === 0) {
        ctx.issues.push({
          code: 'custom',
          message: 'is required in production',
          input: ctx.value[variable],
          path: [variable],
        });
      }
    }
    for (const variable of PROVIDER_VARIABLES) {
      if (ctx.value[variable] === 'fake') {
        ctx.issues.push({
          code: 'custom',
          message: 'must not be fake in production',
          input: ctx.value[variable],
          path: [variable],
        });
      }
    }
  });

export type Config = z.infer<typeof schema>;

// Validates an environment-like object. Throws a readable error listing every
// problem at once, so a broken .env is fixed in one pass.
// `Record<string, string | undefined>` is explained in notes entry 13.
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse(env);

  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `  ${name}: ${issue.message}`;
    });
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  return result.data;
}
