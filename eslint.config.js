// ESLint configuration ("flat config" format).
// Four layers: ESLint's own recommended rules, the TypeScript rules that need
// type information, the module boundaries from CONVENTIONS.md, and Prettier's
// config last so that formatting is never reported as a lint error.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'src/db/migrations/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Lets the TypeScript rules see real types by pointing at tsconfig.json.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A promise that is neither awaited nor handled is almost always a bug.
      '@typescript-eslint/no-floating-promises': 'error',
      // Unused variables are allowed only if they start with an underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Application code logs through Fastify's logger (src/shared/http/logging.ts).
      // console is allowed only in scripts run by hand, such as src/db/check.ts.
      'no-console': 'error',
    },
  },

  // Module boundaries (CONVENTIONS.md). A module reaches another module only
  // through its index.ts, or its schema.ts for a foreign key.
  {
    files: ['src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // "../<module>/<anything but index.js or schema.js>"; ../../ is not a module.
              regex: '^../(?!..)[^/]+/(?!index.js$|schema.js$).+',
              message:
                'Import another module through its index.ts (schema.ts only for foreign keys). See CONVENTIONS.md.',
            },
          ],
        },
      ],
    },
  },
  // Shared code, providers and the job runner never depend on a module.
  // jobs/handlers.ts is the one exception: it assembles every module's jobs.
  {
    files: ['src/shared/**/*.ts', 'src/providers/**/*.ts', 'src/jobs/*.ts'],
    ignores: ['src/jobs/handlers.ts', 'src/jobs/handlers.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/**'],
              message: 'Shared code must not depend on a module. See CONVENTIONS.md.',
            },
          ],
        },
      ],
    },
  },

  // Config files at the repo root are plain JavaScript and do not belong to tsconfig.json.
  {
    files: ['*.js', '*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
