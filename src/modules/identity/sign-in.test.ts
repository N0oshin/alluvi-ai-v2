import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  closeTestDatabase,
  describeWithDatabase,
  migrateTestDatabase,
  testDb,
  truncateAll,
} from '../../../test/db.js';
import { factories } from '../../../test/factories/index.js';
import { accessTokens } from '../../shared/auth/access-token.js';
import { AppError } from '../../shared/http/errors.js';
import { guestSessions, userConsents, users } from './schema.js';
import { initialFirstName, nextStepFor, signIn, type SignInInput } from './sign-in.js';

const terms = { type: 'terms_and_privacy' as const, documentVersion: '2026-09', granted: true };
const marketing = { type: 'marketing' as const, documentVersion: '2026-09', granted: false };

async function errorOf(promise: Promise<unknown>): Promise<AppError | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error : undefined;
  }
}

it('nextStepFor walks the post-sign-up steps in order', () => {
  const user = {
    id: 'u',
    email: null,
    firstName: 'A',
    username: null,
    status: 'active' as const,
    onboardingCompletedAt: null,
  };
  expect(nextStepFor(user, true)).toBe('confirm_name');
  expect(nextStepFor(user, false)).toBe('create_username');
  expect(nextStepFor({ ...user, username: 'h' }, false)).toBe('add_photo');
  expect(nextStepFor({ ...user, username: 'h', onboardingCompletedAt: new Date() }, false)).toBe(
    'home',
  );
  expect(nextStepFor({ ...user, status: 'pending_deletion' }, false)).toBe('restore_account');
});

it('initialFirstName prefers the given name, then the email local part, then a placeholder', () => {
  expect(initialFirstName('  Hamish ', 'h@example.com')).toBe('Hamish');
  expect(initialFirstName(null, 'hamish.g@example.com')).toBe('hamish.g');
  expect(initialFirstName('', null)).toBe('New user');
});

describeWithDatabase('signIn', () => {
  beforeAll(migrateTestDatabase);
  beforeEach(truncateAll);
  afterAll(closeTestDatabase);

  async function input(overrides: Partial<SignInInput> = {}): Promise<SignInInput> {
    const device = await factories.device.create();
    return {
      provider: 'google',
      subject: 'google-sub-1',
      email: 'Hamish@Example.com',
      givenName: 'Hamish',
      familyName: 'Grayson',
      consents: [terms, marketing],
      guestSessionId: null,
      deviceId: device.id,
      timeZone: 'Europe/London',
      ip: '203.0.113.7',
      ...overrides,
    };
  }

  const userCount = async () => (await testDb().select().from(users)).length;

  it('creates an account on first sight: 201, is_new_user, confirm_name, consents and guest session claimed', async () => {
    const device = await factories.device.create();
    const guest = await factories.guestSession.create({ deviceId: device.id });

    const result = await signIn(await input({ deviceId: device.id, guestSessionId: guest.id }));

    expect(result.status).toBe(201);
    expect(result.body.is_new_user).toBe(true);
    expect(result.body.next_step).toBe('confirm_name');
    expect(result.body.user).toEqual({
      id: expect.any(String) as string,
      first_name: 'Hamish',
      username: null,
    });
    expect(result.body.access_expires_in).toBe(900);
    expect(result.body.refresh_token).toMatch(/^rft_/);

    const claims = await accessTokens.verify(result.body.access_token);
    expect(claims.userId).toBe(result.body.user.id);

    const consents = await testDb().select().from(userConsents);
    expect(consents.map((c) => [c.consentType, c.granted])).toEqual([
      ['terms_and_privacy', true],
      ['marketing', false],
    ]);
    const [claimed] = await testDb()
      .select()
      .from(guestSessions)
      .where(eq(guestSessions.id, guest.id));
    expect(claimed?.claimedByUserId).toBe(result.body.user.id);
  });

  it('signs an existing identity in with 200 and no new user', async () => {
    const user = await factories.user.create({ onboardingCompletedAt: null });
    await factories.authIdentity.create({
      userId: user.id,
      provider: 'google',
      providerSubject: 'google-sub-1',
    });

    const result = await signIn(await input({ consents: [] }));
    expect(result.status).toBe(200);
    expect(result.body.is_new_user).toBe(false);
    expect(result.body.next_step).toBe('add_photo');
    expect(await userCount()).toBe(1);
  });

  it('refuses without the terms consent, and writes nothing', async () => {
    const missing = await errorOf(signIn(await input({ consents: [marketing] })));
    expect(missing?.code).toBe('consent_required');
    const declined = await errorOf(
      signIn(await input({ consents: [{ ...terms, granted: false }] })),
    );
    expect(declined?.code).toBe('consent_required');
    expect(await userCount()).toBe(0);
  });

  it('refuses when the email belongs to an account using another provider, naming it', async () => {
    const user = await factories.user.create({ email: 'hamish@example.com' });
    await factories.authIdentity.create({ userId: user.id, provider: 'apple' });

    const error = await errorOf(signIn(await input()));
    expect(error?.code).toBe('email_linked_to_other_provider');
    expect(error?.details).toEqual([
      { field: 'email', code: 'use_apple', message: 'Sign in with Apple instead.' },
    ]);
    expect(await userCount()).toBe(1);
  });

  it('refuses a suspended account and sends a pending-deletion one to restore_account', async () => {
    const suspended = await factories.user.create({ status: 'suspended' });
    await factories.authIdentity.create({
      userId: suspended.id,
      provider: 'google',
      providerSubject: 'google-sub-1',
    });
    const leaving = await factories.user.create({ status: 'pending_deletion' });
    await factories.authIdentity.create({
      userId: leaving.id,
      provider: 'apple',
      providerSubject: 'apple-2',
    });

    expect((await errorOf(signIn(await input())))?.code).toBe('account_suspended');

    const result = await signIn(await input({ provider: 'apple', subject: 'apple-2' }));
    expect(result.status).toBe(200);
    expect(result.body.next_step).toBe('restore_account');
  });

  it('creates an account without an email (Apple relay edge case)', async () => {
    const result = await signIn(
      await input({ provider: 'apple', subject: 'apple-3', email: null, givenName: null }),
    );
    expect(result.status).toBe(201);
    expect(result.body.user.first_name).toBe('New user');
  });
});
