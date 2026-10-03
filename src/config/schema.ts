// Environment configuration: the schema and the validator.
//
// Every environment variable the backend reads is described once in the schema
// below. This file has no side effects (it does not touch process.env), so
// tests can import it and call loadConfig with any input. The real config is
// built in ./index.ts.

import { z } from 'zod';

// The schema: one line per environment variable.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Environment variables are always strings; z.coerce turns "3000" into 3000.
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

// The TypeScript type of a validated config, derived from the schema so the
// two can never drift apart. See docs/typescript-notes.md entry 12.
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
