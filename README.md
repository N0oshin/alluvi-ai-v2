# Alluvi backend

API and background workers for Alluvi AI. Node.js (TypeScript), PostgreSQL on Supabase, Drizzle ORM, images in AWS S3.

## Requirements

- Node.js 24 or newer and npm 11 or newer
- A Supabase project (the PostgreSQL database)

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Copy `.env.example` to `.env`. The `.env` file is git-ignored and must never be committed.

3. Set `DATABASE_URL` in `.env`. In the Supabase dashboard, open the project, click **Connect**, and copy the **Session pooler** URI. Replace `[YOUR-PASSWORD]` with the database password. If the password contains characters such as `@`, `#`, `/` or `:`, URL-encode them.

4. Check the database connection:

   ```
   npm run db:check
   ```

   It prints `database connection ok` and one row with the database name, user and PostgreSQL version.

## Commands

| Command                    | What it does                                          |
| -------------------------- | ----------------------------------------------------- |
| `npm run dev`              | Starts the server and restarts it when a file changes |
| `npm run build`            | Compiles TypeScript to JavaScript in `dist/`          |
| `npm start`                | Runs the compiled server from `dist/`                 |
| `npm test`                 | Runs the tests once                                   |
| `npm run test:watch`       | Runs the tests and re-runs them on changes            |
| `npm run typecheck`        | Checks types without producing output                 |
| `npm run lint`             | Runs ESLint                                           |
| `npm run format`           | Formats every file with Prettier                      |
| `npm run db:check`         | Runs one query to verify `DATABASE_URL`               |
| `npm run migrate:generate` | Generates a SQL migration from the Drizzle schema     |
| `npm run migrate`          | Applies pending migrations to the database            |
| `npm run migrate:check`    | Verifies the migrations are consistent                |

The three `migrate` commands start working in Phase 1.4, when the Drizzle config and the first schema file are added.

## Environment variables

Every variable is listed in `.env.example` and validated at start-up by `src/config/schema.ts`. A missing or invalid variable stops the process with a message naming each problem.

## Logging

The app writes one JSON log line per request and one per unexpected error, through Fastify's built-in Pino logger (`src/http/logging.ts`). `LOG_LEVEL` sets how much is written; it defaults to `debug` in development, `silent` in tests and `info` in production. In development the lines are made readable by `pino-pretty`.

Log lines never contain request or response bodies, query strings, headers, tokens, emails, health values, message text or image URLs (document 03 section 4.4). Known-sensitive field names are replaced with `[Redacted]` as a safety net. Application code logs through `request.log` or `app.log`, never `console`.

## Secrets

A secret is any value that gives access to something: the database password inside `DATABASE_URL`, and later API keys and token signing keys. The rules are the same in every environment:

- Secrets are never committed. `.env` is git-ignored; `.env.example` is committed and holds only variable names and placeholder values.
- The code reads secrets only through `src/config`, and never prints or logs them.
- When a new variable is added, it is added in three places: `src/config/schema.ts`, `.env.example`, and the `.env` file of each environment below.
- If a secret may have leaked (committed, pasted in a chat, shown in a screenshot), change it at the provider at once, update every `.env` file that holds it, and restart the app.

Where the values live:

| Environment            | Where secrets are stored                                     | How the app receives them             |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------- |
| Local                  | Your own `.env` file, on your machine only                   | `src/config` loads `.env` at start-up |
| Staging and production | A `.env` file inside the project folder on the Hostinger VPS | `src/config` loads `.env` at start-up |

The `.env` file on the server is created by hand on the server; it is never copied through git. Lock it so that only the user that runs the app can read it:

```
chmod 600 .env
```
