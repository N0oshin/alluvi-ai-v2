import { desc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { factories } from '../../../test/factories/index.js';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  testDb,
  truncateAll,
} from '../../../test/db.js';
import {
  authIdentities,
  devices,
  guestSessions,
  magicLinkTokens,
  sessions,
  userConsents,
  users,
} from './identity.js';

const casing = new CasingCache('snake_case');

// Drizzle wraps a failed query in its own error and keeps the PostgreSQL error
// as `cause`; the name of the constraint that fired is on that inner error.
async function violatedConstraint(insert: Promise<unknown>): Promise<string | undefined> {
  try {
    await insert;
    return undefined;
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint;
  }
}
const columnName = (column: Parameters<CasingCache['getColumnCasing']>[0]) =>
  casing.getColumnCasing(column);

describe('users', () => {
  const columns = getTableColumns(users);

  it('has the base columns and the account fields', () => {
    expect(getTableName(users)).toBe('users');
    expect(Object.keys(columns).sort()).toEqual(
      [
        'id',
        'createdAt',
        'updatedAt',
        'email',
        'firstName',
        'lastName',
        'username',
        'avatarKind',
        'avatarColor',
        'avatarMediaId',
        'timeZone',
        'status',
        'onboardingCompletedAt',
        'deletionRequestedAt',
      ].sort(),
    );
    expect(columnName(columns.firstName)).toBe('first_name');
    expect(columnName(columns.onboardingCompletedAt)).toBe('onboarding_completed_at');
  });

  it('requires a first name, a time zone and a status, and nothing else', () => {
    const required = Object.entries(columns)
      .filter(([, column]) => column.notNull)
      .map(([name]) => name)
      .sort();
    expect(required).toEqual(
      ['id', 'createdAt', 'updatedAt', 'firstName', 'avatarKind', 'timeZone', 'status'].sort(),
    );
    expect(columns.status.default).toBe('active');
    expect(columns.avatarKind.default).toBe('initials');
  });

  it('is unique on lower(email) and lower(username) where set, with the four checks', () => {
    const config = getTableConfig(users);
    expect(
      config.indexes.map((i) => [i.config.name, i.config.unique, i.config.where !== undefined]),
    ).toEqual([
      ['users_email_lower', true, true],
      ['users_username_lower', true, true],
    ]);
    expect(config.checks.map((c) => c.name).sort()).toEqual([
      'users_avatar_color_range',
      'users_first_name_length',
      'users_last_name_length',
      'users_username_format',
    ]);
  });
});

describeWithDatabase('users in the database', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  it('creates a row through the factory with generated id and timestamps', async () => {
    const row = await factories.user.create({ firstName: 'Ann' });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.firstName).toBe('Ann');
    expect(row.status).toBe('active');
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('treats emails and usernames as the same regardless of case', async () => {
    await factories.user.create({ email: 'Ann@Example.com', username: 'AnnG' });
    expect(await violatedConstraint(factories.user.create({ email: 'ann@example.com' }))).toBe(
      'users_email_lower',
    );
    expect(await violatedConstraint(factories.user.create({ username: 'anng' }))).toBe(
      'users_username_lower',
    );
  });

  it('allows many rows with no email or no username', async () => {
    await factories.user.create({ email: null, username: null });
    await factories.user.create({ email: null, username: null });
  });

  it('rejects a username outside the rules and an avatar colour outside 1 to 5', async () => {
    expect(await violatedConstraint(factories.user.create({ username: 'ab' }))).toBe(
      'users_username_format',
    );
    expect(await violatedConstraint(factories.user.create({ username: 'ann-g' }))).toBe(
      'users_username_format',
    );
    expect(await violatedConstraint(factories.user.create({ avatarColor: 6 }))).toBe(
      'users_avatar_color_range',
    );
    expect(await violatedConstraint(factories.user.create({ firstName: '' }))).toBe(
      'users_first_name_length',
    );
  });
});

describe('auth_identities', () => {
  const columns = getTableColumns(authIdentities);

  it('has the base columns and the link fields', () => {
    expect(getTableName(authIdentities)).toBe('auth_identities');
    expect(Object.keys(columns).sort()).toEqual(
      [
        'id',
        'createdAt',
        'updatedAt',
        'userId',
        'provider',
        'providerSubject',
        'emailAtProvider',
        'lastUsedAt',
      ].sort(),
    );
    expect(columnName(columns.providerSubject)).toBe('provider_subject');
    expect(columns.userId.notNull).toBe(true);
    expect(columns.provider.notNull).toBe(true);
    expect(columns.providerSubject.notNull).toBe(true);
    expect(columns.emailAtProvider.notNull).toBe(false);
  });

  it('points at users and is deleted with the user', () => {
    const keys = getTableConfig(authIdentities).foreignKeys;
    expect(keys).toHaveLength(1);
    const fk = keys[0];
    if (fk === undefined) throw new Error('unreachable');
    const reference = fk.reference();
    expect(getTableName(reference.foreignTable)).toBe('users');
    expect(reference.columns.map(columnName)).toEqual(['user_id']);
    expect(reference.foreignColumns.map(columnName)).toEqual(['id']);
    expect(fk.onDelete).toBe('cascade');
  });

  it('is unique per provider and subject, and indexed by user', () => {
    const config = getTableConfig(authIdentities);
    expect(config.indexes.map((i) => [i.config.name, i.config.unique])).toEqual([
      ['auth_identities_provider_subject', true],
      ['auth_identities_user_id', false],
    ]);
  });
});

describeWithDatabase('auth_identities in the database', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  it('links a sign-in method to an existing user', async () => {
    const user = await factories.user.create();
    const identity = await factories.authIdentity.create({ userId: user.id, provider: 'apple' });
    expect(identity.userId).toBe(user.id);
    expect(identity.provider).toBe('apple');
  });

  it('refuses a user id that does not exist', async () => {
    expect(await violatedConstraint(factories.authIdentity.create())).toBe(
      'auth_identities_user_id_users_id_fk',
    );
  });

  it('allows one link per external account', async () => {
    const user = await factories.user.create();
    const other = await factories.user.create();
    await factories.authIdentity.create({ userId: user.id, providerSubject: 'sub-1' });
    expect(
      await violatedConstraint(
        factories.authIdentity.create({ userId: other.id, providerSubject: 'sub-1' }),
      ),
    ).toBe('auth_identities_provider_subject');
    // The same subject under a different provider is a different account.
    await factories.authIdentity.create({
      userId: other.id,
      provider: 'apple',
      providerSubject: 'sub-1',
    });
  });

  it('deletes the identities when the user is deleted', async () => {
    const user = await factories.user.create();
    await factories.authIdentity.create({ userId: user.id });
    await factories.authIdentity.create({ userId: user.id, provider: 'email' });
    await testDb().delete(users).where(eq(users.id, user.id));
    const left = await testDb()
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, user.id));
    expect(left).toHaveLength(0);
  });
});

describe('devices', () => {
  const columns = getTableColumns(devices);

  it('has the base columns and the phone fields', () => {
    expect(getTableName(devices)).toBe('devices');
    expect(Object.keys(columns).sort()).toEqual(
      [
        'id',
        'createdAt',
        'updatedAt',
        'userId',
        'platform',
        'pushToken',
        'pushPermission',
        'exactAlarmPermission',
        'appVersion',
        'osVersion',
      ].sort(),
    );
    expect(columnName(columns.exactAlarmPermission)).toBe('exact_alarm_permission');
  });

  it('allows a device with no user yet, and defaults push permission to not_determined', () => {
    expect(columns.userId.notNull).toBe(false);
    expect(columns.platform.notNull).toBe(true);
    expect(columns.pushPermission.default).toBe('not_determined');
    expect(columns.exactAlarmPermission.notNull).toBe(false);
  });

  it('points at users with cascade, and is indexed by user', () => {
    const config = getTableConfig(devices);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]?.onDelete).toBe('cascade');
    expect(config.indexes.map((i) => [i.config.name, i.config.unique])).toEqual([
      ['devices_user_id', false],
    ]);
  });
});

describeWithDatabase('devices in the database', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  it('creates a guest device and later attaches it to a user', async () => {
    const guest = await factories.device.create();
    expect(guest.userId).toBeNull();
    expect(guest.pushPermission).toBe('granted');

    const user = await factories.user.create();
    await testDb().update(devices).set({ userId: user.id }).where(eq(devices.id, guest.id));
    const [attached] = await testDb().select().from(devices).where(eq(devices.id, guest.id));
    expect(attached?.userId).toBe(user.id);
  });

  it('rejects a permission value outside the enum', async () => {
    // No constraint name here: an enum violation is a type error in
    // PostgreSQL, so the message on the inner error is checked instead.
    const error = await factories.device
      .create({ pushPermission: 'maybe' as unknown as 'granted' })
      .then(() => undefined)
      .catch((e: unknown) => e);
    const cause = (error as { cause?: { message?: string } }).cause;
    expect(cause?.message).toMatch(/invalid input value for enum permission_state/);
  });

  it('keeps guest devices but deletes a user’s devices with the user', async () => {
    const user = await factories.user.create();
    await factories.device.create({ userId: user.id, platform: 'android' });
    const guest = await factories.device.create();
    await testDb().delete(users).where(eq(users.id, user.id));
    const left = await testDb().select().from(devices);
    expect(left.map((d) => d.id)).toEqual([guest.id]);
  });
});

describe('sessions', () => {
  const columns = getTableColumns(sessions);

  it('has the base columns and the session fields', () => {
    expect(getTableName(sessions)).toBe('sessions');
    expect(Object.keys(columns).sort()).toEqual(
      [
        'id',
        'createdAt',
        'updatedAt',
        'userId',
        'deviceId',
        'refreshTokenHash',
        'previousRefreshTokenHash',
        'expiresAt',
        'revokedAt',
      ].sort(),
    );
    expect(columnName(columns.refreshTokenHash)).toBe('refresh_token_hash');
    expect(columns.userId.notNull).toBe(true);
    expect(columns.deviceId.notNull).toBe(true);
    expect(columns.refreshTokenHash.notNull).toBe(true);
    expect(columns.expiresAt.notNull).toBe(true);
    expect(columns.revokedAt.notNull).toBe(false);
  });

  it('points at users and devices, both with cascade', () => {
    const keys = getTableConfig(sessions).foreignKeys;
    const targets = keys.map((fk) => [getTableName(fk.reference().foreignTable), fk.onDelete]);
    expect(targets.sort()).toEqual([
      ['devices', 'cascade'],
      ['users', 'cascade'],
    ]);
  });

  it('is unique on the token hash, indexed for live sessions per user, and checks the hash shape', () => {
    const config = getTableConfig(sessions);
    expect(
      config.indexes.map((i) => [i.config.name, i.config.unique, i.config.where !== undefined]),
    ).toEqual([
      ['sessions_refresh_token_hash', true, false],
      ['sessions_previous_refresh_token_hash', false, false],
      ['sessions_user_id_live', false, true],
      ['sessions_device_id', false, false],
    ]);
    expect(config.checks.map((c) => c.name).sort()).toEqual([
      'sessions_previous_refresh_token_hash_format',
      'sessions_refresh_token_hash_format',
    ]);
  });
});

describeWithDatabase('sessions in the database', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  async function signedInDevice() {
    const user = await factories.user.create();
    const device = await factories.device.create({ userId: user.id });
    return { user, device };
  }

  it('creates a live session for a user on a device', async () => {
    const { user, device } = await signedInDevice();
    const row = await factories.session.create({ userId: user.id, deviceId: device.id });
    expect(row.revokedAt).toBeNull();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses the same token hash twice and a hash that is not SHA-256 hex', async () => {
    const { user, device } = await signedInDevice();
    const first = await factories.session.create({ userId: user.id, deviceId: device.id });
    expect(
      await violatedConstraint(
        factories.session.create({
          userId: user.id,
          deviceId: device.id,
          refreshTokenHash: first.refreshTokenHash,
        }),
      ),
    ).toBe('sessions_refresh_token_hash');
    expect(
      await violatedConstraint(
        factories.session.create({
          userId: user.id,
          deviceId: device.id,
          refreshTokenHash: 'plain-token',
        }),
      ),
    ).toBe('sessions_refresh_token_hash_format');
  });

  it('refuses a session on a device or user that does not exist', async () => {
    const { user, device } = await signedInDevice();
    expect(await violatedConstraint(factories.session.create({ userId: user.id }))).toBe(
      'sessions_device_id_devices_id_fk',
    );
    expect(await violatedConstraint(factories.session.create({ deviceId: device.id }))).toBe(
      'sessions_user_id_users_id_fk',
    );
  });

  it('is deleted with its device', async () => {
    const { user, device } = await signedInDevice();
    await factories.session.create({ userId: user.id, deviceId: device.id });
    await testDb().delete(devices).where(eq(devices.id, device.id));
    expect(await testDb().select().from(sessions)).toHaveLength(0);
  });
});

describe('guest_sessions', () => {
  const columns = getTableColumns(guestSessions);

  it('has the base columns and the guest fields', () => {
    expect(getTableName(guestSessions)).toBe('guest_sessions');
    expect(Object.keys(columns).sort()).toEqual(
      [
        'id',
        'createdAt',
        'updatedAt',
        'deviceId',
        'tokenHash',
        'claimedByUserId',
        'expiresAt',
      ].sort(),
    );
    expect(columnName(columns.claimedByUserId)).toBe('claimed_by_user_id');
    expect(columns.deviceId.notNull).toBe(true);
    expect(columns.tokenHash.notNull).toBe(true);
    expect(columns.claimedByUserId.notNull).toBe(false);
    expect(columns.expiresAt.notNull).toBe(true);
  });

  it('cascades from devices and clears the link when the claiming user goes', () => {
    const keys = getTableConfig(guestSessions).foreignKeys;
    const targets = keys.map((fk) => [getTableName(fk.reference().foreignTable), fk.onDelete]);
    expect(targets.sort()).toEqual([
      ['devices', 'cascade'],
      ['users', 'set null'],
    ]);
  });

  it('is unique on the token hash and indexed for lookup and purge', () => {
    const config = getTableConfig(guestSessions);
    expect(config.indexes.map((i) => [i.config.name, i.config.unique])).toEqual([
      ['guest_sessions_token_hash', true],
      ['guest_sessions_device_id', false],
      ['guest_sessions_claimed_by_user_id', false],
      ['guest_sessions_expires_at', false],
    ]);
    expect(config.checks.map((c) => c.name)).toEqual(['guest_sessions_token_hash_format']);
  });
});

describeWithDatabase('guest_sessions in the database', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  it('starts unclaimed on a guest device', async () => {
    const device = await factories.device.create();
    const row = await factories.guestSession.create({ deviceId: device.id });
    expect(row.claimedByUserId).toBeNull();
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is claimed by a user, and keeps the row if that user is deleted', async () => {
    const device = await factories.device.create();
    const guest = await factories.guestSession.create({ deviceId: device.id });
    const user = await factories.user.create();
    await testDb()
      .update(guestSessions)
      .set({ claimedByUserId: user.id })
      .where(eq(guestSessions.id, guest.id));
    await testDb().delete(users).where(eq(users.id, user.id));
    const [after] = await testDb()
      .select()
      .from(guestSessions)
      .where(eq(guestSessions.id, guest.id));
    expect(after).toBeDefined();
    expect(after?.claimedByUserId).toBeNull();
  });

  it('refuses a duplicate token hash and an unknown device', async () => {
    const device = await factories.device.create();
    const first = await factories.guestSession.create({ deviceId: device.id });
    expect(
      await violatedConstraint(
        factories.guestSession.create({ deviceId: device.id, tokenHash: first.tokenHash }),
      ),
    ).toBe('guest_sessions_token_hash');
    expect(await violatedConstraint(factories.guestSession.create())).toBe(
      'guest_sessions_device_id_devices_id_fk',
    );
  });
});

describe('magic_link_tokens', () => {
  const columns = getTableColumns(magicLinkTokens);

  it('has the base columns and the link fields', () => {
    expect(getTableName(magicLinkTokens)).toBe('magic_link_tokens');
    expect(Object.keys(columns).sort()).toEqual(
      [
        'id',
        'createdAt',
        'updatedAt',
        'email',
        'tokenHash',
        'intent',
        'guestSessionId',
        'expiresAt',
        'consumedAt',
        'requestedIp',
        'requestedDeviceId',
      ].sort(),
    );
    expect(columnName(columns.requestedDeviceId)).toBe('requested_device_id');
    expect(columns.email.notNull).toBe(true);
    expect(columns.tokenHash.notNull).toBe(true);
    expect(columns.intent.notNull).toBe(true);
    expect(columns.expiresAt.notNull).toBe(true);
    expect(columns.consumedAt.notNull).toBe(false);
    expect(columns.guestSessionId.notNull).toBe(false);
  });

  it('points only at guest_sessions, with set null', () => {
    const keys = getTableConfig(magicLinkTokens).foreignKeys;
    expect(keys.map((fk) => [getTableName(fk.reference().foreignTable), fk.onDelete])).toEqual([
      ['guest_sessions', 'set null'],
    ]);
  });

  it('is unique on the token hash, indexed by email and expiry, with two checks', () => {
    const config = getTableConfig(magicLinkTokens);
    expect(config.indexes.map((i) => [i.config.name, i.config.unique])).toEqual([
      ['magic_link_tokens_token_hash', true],
      ['magic_link_tokens_email_created', false],
      ['magic_link_tokens_guest_session_id', false],
      ['magic_link_tokens_expires_at', false],
    ]);
    expect(config.checks.map((c) => c.name).sort()).toEqual([
      'magic_link_tokens_email_lowercase',
      'magic_link_tokens_token_hash_format',
    ]);
  });
});

describeWithDatabase('magic_link_tokens in the database', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  it('creates an unused sign-in link that expires in the future', async () => {
    const row = await factories.magicLinkToken.create({ email: 'ann@example.com' });
    expect(row.intent).toBe('sign_in');
    expect(row.consumedAt).toBeNull();
    expect(row.guestSessionId).toBeNull();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.requestedIp).toBe('203.0.113.7');
  });

  it('refuses an address that is not lowercased, and a duplicate hash', async () => {
    expect(
      await violatedConstraint(factories.magicLinkToken.create({ email: 'Ann@Example.com' })),
    ).toBe('magic_link_tokens_email_lowercase');
    const first = await factories.magicLinkToken.create();
    expect(
      await violatedConstraint(factories.magicLinkToken.create({ tokenHash: first.tokenHash })),
    ).toBe('magic_link_tokens_token_hash');
  });

  it('ties a sign-up link to a guest session, and keeps the link if the session is purged', async () => {
    const device = await factories.device.create();
    const guest = await factories.guestSession.create({ deviceId: device.id });
    const link = await factories.magicLinkToken.create({
      intent: 'sign_up',
      guestSessionId: guest.id,
    });
    await testDb().delete(guestSessions).where(eq(guestSessions.id, guest.id));
    const [after] = await testDb()
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, link.id));
    expect(after?.guestSessionId).toBeNull();
  });
});

describe('user_consents', () => {
  const columns = getTableColumns(userConsents);

  it('is append-only: an id and created_at, but no updated_at', () => {
    expect(getTableName(userConsents)).toBe('user_consents');
    expect(Object.keys(columns).sort()).toEqual(
      ['id', 'createdAt', 'userId', 'consentType', 'documentVersion', 'granted', 'sourceIp'].sort(),
    );
    expect(columnName(columns.documentVersion)).toBe('document_version');
    expect(columns.userId.notNull).toBe(true);
    expect(columns.consentType.notNull).toBe(true);
    expect(columns.documentVersion.notNull).toBe(true);
    expect(columns.granted.notNull).toBe(true);
    expect(columns.sourceIp.notNull).toBe(false);
  });

  it('points at users with cascade and is indexed for the latest decision per type', () => {
    const config = getTableConfig(userConsents);
    expect(config.foreignKeys.map((fk) => fk.onDelete)).toEqual(['cascade']);
    expect(config.indexes.map((i) => [i.config.name, i.config.unique])).toEqual([
      ['user_consents_user_type_created', false],
    ]);
    expect(config.checks.map((c) => c.name)).toEqual(['user_consents_document_version_length']);
  });
});

describeWithDatabase('user_consents in the database', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  it('records a granted consent with the server time', async () => {
    const user = await factories.user.create();
    const row = await factories.userConsent.create({ userId: user.id });
    expect(row.granted).toBe(true);
    expect(row.consentType).toBe('terms_and_privacy');
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('keeps every decision, so a withdrawal is a second row', async () => {
    const user = await factories.user.create();
    await factories.userConsent.create({ userId: user.id, consentType: 'marketing' });
    await factories.userConsent.create({
      userId: user.id,
      consentType: 'marketing',
      granted: false,
    });
    const rows = await testDb()
      .select()
      .from(userConsents)
      .where(eq(userConsents.userId, user.id))
      .orderBy(desc(userConsents.createdAt), desc(userConsents.id));
    expect(rows.map((r) => r.granted)).toEqual([false, true]);
  });

  it('refuses a consent for a user that does not exist, and an empty document version', async () => {
    expect(await violatedConstraint(factories.userConsent.create())).toBe(
      'user_consents_user_id_users_id_fk',
    );
    const user = await factories.user.create();
    expect(
      await violatedConstraint(
        factories.userConsent.create({ userId: user.id, documentVersion: '' }),
      ),
    ).toBe('user_consents_document_version_length');
  });
});
