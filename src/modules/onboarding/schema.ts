import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  timestamp,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  acquisitionSourceEnum,
  jobStatusEnum,
  motivationEnum,
  obstacleEnum,
  planStepEnum,
  sexEnum,
  unitSystemEnum,
  weightGoalDirectionEnum,
  workoutFrequencyEnum,
} from '../../shared/schema.js';
import { guestSessions, users } from '../identity/schema.js';
import { baseColumns } from '../../shared/schema.js';

const instant = () => timestamp({ withTimezone: true });

// The questionnaire answers, screens 92 to 109. One row belongs to a guest
// session while the person is answering, and to the user once they sign up
// (Phase 3.4 moves it: sets `user_id`, clears `guest_session_id`). Every answer
// is nullable because each screen saves on its own "Continue"; the API's
// `missing_fields` is what says the questionnaire is finished.
export const onboardingResponses = pgTable(
  'onboarding_responses',
  {
    ...baseColumns,
    guestSessionId: uuid().references(() => guestSessions.id, { onDelete: 'cascade' }),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    sex: sexEnum(),
    workoutFrequency: workoutFrequencyEnum(),
    birthDate: date({ mode: 'string' }),
    acquisitionSource: acquisitionSourceEnum(),
    triedOtherApps: boolean(),
    // `mode: 'number'` hands the app a JS number. The default is a string,
    // because PostgreSQL numeric can hold more digits than a double can.
    heightCm: numeric({ precision: 5, scale: 2, mode: 'number' }),
    weightKg: numeric({ precision: 5, scale: 1, mode: 'number' }),
    targetWeightKg: numeric({ precision: 5, scale: 1, mode: 'number' }),
    worksWithProfessional: boolean(),
    goal: weightGoalDirectionEnum(),
    obstacle: obstacleEnum(),
    motivation: motivationEnum(),
    syncWorkouts: boolean(),
    addBurnedCalories: boolean(),
    rolloverCalories: boolean(),
    unitSystem: unitSystemEnum(),
    // Set when the last required answer is saved.
    completedAt: instant(),
  },
  (table) => [
    // One row per guest session and one per user. NULLs are distinct in a
    // unique index, so the many claimed rows (guest_session_id null) are fine.
    uniqueIndex('onboarding_responses_guest_session_id').on(table.guestSessionId),
    uniqueIndex('onboarding_responses_user_id').on(table.userId),
    // Document 01 section 4.2: exactly one owner.
    check(
      'onboarding_responses_one_owner',
      sql`num_nonnulls(${table.guestSessionId}, ${table.userId}) = 1`,
    ),
    // Same bounds as user_profiles and weight_entries (document 01 section 4.2).
    // "Birth date not in the future" is the API's job: a CHECK that reads
    // today's date is not immutable and can fail when a backup is restored.
    check('onboarding_responses_height_range', sql`${table.heightCm} between 90 and 250`),
    check('onboarding_responses_weight_range', sql`${table.weightKg} between 20 and 400`),
    check(
      'onboarding_responses_target_weight_range',
      sql`${table.targetWeightKg} between 20 and 400`,
    ),
    check('onboarding_responses_birth_date_floor', sql`${table.birthDate} >= date '1900-01-01'`),
  ],
);

// One attempt to build a plan from a set of answers (screens 113 to 116). A
// retry after a failure is a new row, which is why this is 1:N. The worker
// moves `status` through document 01 section 6.2 and ticks `steps_completed`.
export const planGenerations = pgTable(
  'plan_generations',
  {
    ...baseColumns,
    onboardingResponseId: uuid()
      .notNull()
      .references(() => onboardingResponses.id, { onDelete: 'cascade' }),
    status: jobStatusEnum().notNull().default('queued'),
    progressPct: smallint().notNull().default(0),
    // Steps finished so far, in tick order; the client draws the five lines
    // from this, and `progress_pct` from the worker.
    stepsCompleted: planStepEnum()
      .array()
      .notNull()
      .default(sql`'{}'`),
    // The numbers on screen 116. Its shape belongs to the calculator
    // (Phase 3.3), so it is left untyped here. Null until `completed`.
    result: jsonb(),
    // Which version of the calculation produced `result`; the "How we make
    // recommendations" link needs it. Null until the calculator has run.
    algorithmVersion: text(),
    // Why a `failed` generation failed; returned to the client as `failure_code`.
    failureCode: text(),
  },
  (table) => [
    // "Latest generation for these answers" reads the first row of this index.
    index('plan_generations_response_created').on(
      table.onboardingResponseId,
      table.createdAt.desc(),
    ),
    check('plan_generations_progress_range', sql`${table.progressPct} between 0 and 100`),
    // A finished generation always has its numbers; a failed one always says why.
    check(
      'plan_generations_completed_has_result',
      sql`${table.status} <> 'completed' or (${table.result} is not null and ${table.algorithmVersion} is not null)`,
    ),
    check(
      'plan_generations_failed_has_code',
      sql`${table.status} <> 'failed' or ${table.failureCode} is not null`,
    ),
  ],
);
