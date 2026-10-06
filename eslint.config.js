// ESLint configuration ("flat config" format).
// Three layers: ESLint's own recommended rules, the TypeScript rules that need type
// information, and Prettier's config last so that formatting is never reported as a lint error.

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
      // Application code logs through Fastify's logger (src/http/logging.ts).
      // console is allowed only in scripts run by hand, such as src/db/check.ts.
      'no-console': 'error',
    },
  },

  // Config files at the repo root are plain JavaScript and do not belong to tsconfig.json.
  {
    files: ['*.js', '*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
