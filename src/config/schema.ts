//
// Every environment variable the backend reads is described once in the schema
// below. This file has no side effects (it does not touch process.env), so
// tests can import it and call loadConfig with any input. The real config is
// built in ./index.ts.

import { z } from 'zod';
import { LOG_LEVELS } from '../http/logging.js';

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
const schema = rawSchema.transform((data) => ({
  ...data,
  LOG_LEVEL: data.LOG_LEVEL ?? defaultLogLevel(data.NODE_ENV),
}));

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
