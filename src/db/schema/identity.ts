import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  inet,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  authProviderEnum,
  avatarKindEnum,
  consentTypeEnum,
  magicIntentEnum,
  permissionStateEnum,
  platformEnum,
  userStatusEnum,
} from './enums.js';
import { baseColumns, id } from './shared.js';

const instant = () => timestamp({ withTimezone: true });

export const users = pgTable(
  'users',
  {
    ...baseColumns,
    // Null only for the Apple "hide my email" relay edge cases.
    email: text(),
    firstName: text().notNull(),
    lastName: text(),
    username: text(),
    avatarKind: avatarKindEnum().notNull().default('initials'),
    avatarColor: smallint(),
    // Points at media.id. The media table arrives in Phase 5, which adds the
    // foreign key then; until that migration this is an unchecked uuid.
    avatarMediaId: uuid(),
    // IANA name such as 'Europe/London'. Day boundaries, reminders and fasting
    // all depend on it, so it is required from the first row.
    timeZone: text().notNull(),
    // State machine in document 01 section 6.1.
    status: userStatusEnum().notNull().default('active'),
    onboardingCompletedAt: instant(),
    deletionRequestedAt: instant(),
  },
  (table) => [
    uniqueIndex('users_email_lower')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.email} is not null`),
    uniqueIndex('users_username_lower')
      .on(sql`lower(${table.username})`)
      .where(sql`${table.username} is not null`),
    // Lengths and the username alphabet from document 01 section 2.1.
    check('users_first_name_length', sql`char_length(${table.firstName}) between 1 and 50`),
    check('users_last_name_length', sql`char_length(${table.lastName}) <= 50`),
    check(
      'users_username_format',
      sql`${table.username} is null or ${table.username} ~ '^[A-Za-z0-9_.]{3,20}$'`,
    ),
    check('users_avatar_color_range', sql`${table.avatarColor} between 1 and 5`),
  ],
);

// One row per sign-in method linked to a user: Sign in with Apple, Google, or
// an email address. A user can have several; the same external account can
// belong to only one user.
export const authIdentities = pgTable(
  'auth_identities',
  {
    ...baseColumns,
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProviderEnum().notNull(),
    providerSubject: text().notNull(),
    emailAtProvider: text(),
    lastUsedAt: instant(),
  },
  (table) => [
    uniqueIndex('auth_identities_provider_subject').on(table.provider, table.providerSubject),
    index('auth_identities_user_id').on(table.userId),
  ],
);

// One row per app install. The phone generates `install_id` once at first
// launch and sends it with every guest session request and magic link
// consumption; a reinstall gets a new id and so a new row. (Decision 36.)
export const devices = pgTable(
  'devices',
  {
    ...baseColumns,
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    installId: text().notNull(),
    platform: platformEnum().notNull(),
    // FCM registration token. Null until the app has permission and a token.
    pushToken: text(),
    pushPermission: permissionStateEnum().notNull().default('not_determined'),
    // Android only; null on iOS.
    exactAlarmPermission: permissionStateEnum(),
    appVersion: text(),
    osVersion: text(),
  },
  (table) => [
    index('devices_user_id').on(table.userId),
    // POST /v1/guest-sessions looks a device up by install id, and the same
    // install must never produce two device rows.
    uniqueIndex('devices_install_id').on(table.installId),
    check('devices_install_id_length', sql`char_length(${table.installId}) between 8 and 128`),
  ],
);

// A signed-in device. One row per sign-in; it lives until it expires, the
// user logs out (`revokedAt` set) or the user is deleted. The refresh token
// itself is never stored: only its SHA-256 hash, as 64 hex characters,
export const sessions = pgTable(
  'sessions',
  {
    ...baseColumns,
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    refreshTokenHash: text().notNull(),
    previousRefreshTokenHash: text(),
    expiresAt: instant().notNull(),
    revokedAt: instant(),
  },
  (table) => [
    // The refresh endpoint looks a session up by the hash of the token it was given.
    uniqueIndex('sessions_refresh_token_hash').on(table.refreshTokenHash),
    index('sessions_previous_refresh_token_hash').on(table.previousRefreshTokenHash),
    // "Log out everywhere" and "list my sessions" read only the live ones.
    index('sessions_user_id_live')
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),
    index('sessions_device_id').on(table.deviceId),
    check('sessions_refresh_token_hash_format', sql`${table.refreshTokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'sessions_previous_refresh_token_hash_format',
      sql`${table.previousRefreshTokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const guestSessions = pgTable(
  'guest_sessions',
  {
    ...baseColumns,
    deviceId: uuid()
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull(),
    claimedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    expiresAt: instant().notNull(),
  },
  (table) => [
    uniqueIndex('guest_sessions_token_hash').on(table.tokenHash),
    index('guest_sessions_device_id').on(table.deviceId),
    index('guest_sessions_claimed_by_user_id').on(table.claimedByUserId),
    index('guest_sessions_expires_at').on(table.expiresAt),
    check('guest_sessions_token_hash_format', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    ...baseColumns,
    email: text().notNull(),
    tokenHash: text().notNull(),
    intent: magicIntentEnum().notNull(),
    guestSessionId: uuid().references(() => guestSessions.id, { onDelete: 'set null' }),
    expiresAt: instant().notNull(),
    consumedAt: instant(),
    requestedIp: inet(),
    requestedDeviceId: uuid(),
  },
  (table) => [
    uniqueIndex('magic_link_tokens_token_hash').on(table.tokenHash),
    // The 30 second resend cooldown and the per-address rate limit read the
    // latest requests for an address.
    index('magic_link_tokens_email_created').on(table.email, table.createdAt.desc()),
    index('magic_link_tokens_guest_session_id').on(table.guestSessionId),
    // The purge job (Phase 2.4) deletes by expiry.
    index('magic_link_tokens_expires_at').on(table.expiresAt),
    check('magic_link_tokens_token_hash_format', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('magic_link_tokens_email_lowercase', sql`${table.email} = lower(${table.email})`),
  ],
);

export const userConsents = pgTable(
  'user_consents',
  {
    ...id,
    createdAt: instant().defaultNow().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    consentType: consentTypeEnum().notNull(),
    // Which version of the terms or policy text the person saw, e.g. '2026-09'.
    documentVersion: text().notNull(),
    granted: boolean().notNull(),
    sourceIp: inet(),
  },
  (table) => [
    // "Latest decision per user and type" reads the first row of this index.
    index('user_consents_user_type_created').on(
      table.userId,
      table.consentType,
      table.createdAt.desc(),
    ),
    check(
      'user_consents_document_version_length',
      sql`char_length(${table.documentVersion}) between 1 and 50`,
    ),
  ],
);
