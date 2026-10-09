import { describe, expect, it } from 'vitest';
import { ephemeralAccessTokenService } from '../../auth/access-token.js';
import { memoryAccountStore } from '../../db/account-store.js';
import { AppError } from '../../http/errors.js';
import { createSignInService, initialFirstName, nextStepFor, type SignInInput } from './sign-in.js';

const terms = { type: 'terms_and_privacy' as const, documentVersion: '2026-09', granted: true };
const marketing = { type: 'marketing' as const, documentVersion: '2026-09', granted: false };

const base: SignInInput = {
  provider: 'google',
  subject: 'google-sub-1',
  email: 'Hamish@Example.com',
  givenName: 'Hamish',
  familyName: 'Grayson',
  consents: [terms, marketing],
  guestSessionId: null,
  deviceId: '019a0000-0000-7000-8000-000000000003',
  timeZone: 'Europe/London',
  ip: '203.0.113.7',
};

function setup() {
  const accounts = memoryAccountStore();
  const accessTokens = ephemeralAccessTokenService();
  const service = createSignInService({ accounts, accessTokens });
  return { accounts, accessTokens, service };
}

async function errorOf(promise: Promise<unknown>): Promise<AppError | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error : undefined;
  }
}

describe('nextStepFor', () => {
  const user = {
    id: 'u',
    email: null,
    firstName: 'A',
    username: null,
    status: 'active' as const,
    onboardingCompletedAt: null,
  };
  it('walks the post-sign-up steps in order', () => {
    expect(nextStepFor(user, true)).toBe('confirm_name');
    expect(nextStepFor(user, false)).toBe('create_username');
    expect(nextStepFor({ ...user, username: 'h' }, false)).toBe('add_photo');
    expect(nextStepFor({ ...user, username: 'h', onboardingCompletedAt: new Date() }, false)).toBe(
      'home',
    );
  });
  it('sends an account pending deletion to restoration first', () => {
    expect(nextStepFor({ ...user, status: 'pending_deletion' }, false)).toBe('restore_account');
  });
});

describe('initialFirstName', () => {
  it('prefers the given name, then the email local part, then a placeholder', () => {
    expect(initialFirstName('  Hamish ', 'h@example.com')).toBe('Hamish');
    expect(initialFirstName(null, 'hamish.g@example.com')).toBe('hamish.g');
    expect(initialFirstName('', null)).toBe('New user');
  });
});

describe('signIn', () => {
  it('creates an account on first sight: 201, is_new_user, confirm_name, consents stored', async () => {
    const { accounts, accessTokens, service } = setup();
    const result = await service.signIn({ ...base, guestSessionId: 'guest-1' });

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

    expect(accounts.consents).toEqual([terms, marketing]);
    expect(accounts.claimedGuestSessions).toEqual(['guest-1']);
  });

  it('signs an existing identity in with 200 and no new user', async () => {
    const { accounts, service } = setup();
    accounts.addUser({ firstName: 'Hamish', username: 'hamish_g' }, [
      { provider: 'google', subject: 'google-sub-1' },
    ]);

    const result = await service.signIn({ ...base, consents: [] });
    expect(result.status).toBe(200);
    expect(result.body.is_new_user).toBe(false);
    expect(result.body.next_step).toBe('add_photo');
    expect(accounts.users.size).toBe(1);
  });

  it('refuses without the terms consent, and writes nothing', async () => {
    const { accounts, service } = setup();
    const missing = await errorOf(service.signIn({ ...base, consents: [marketing] }));
    expect(missing?.code).toBe('consent_required');
    const declined = await errorOf(
      service.signIn({ ...base, consents: [{ ...terms, granted: false }] }),
    );
    expect(declined?.code).toBe('consent_required');
    expect(accounts.users.size).toBe(0);
  });

  it('refuses when the email belongs to an account using another provider, naming it', async () => {
    const { accounts, service } = setup();
    accounts.addUser({ email: 'hamish@example.com' }, [{ provider: 'apple', subject: 'apple-1' }]);

    const error = await errorOf(service.signIn(base));
    expect(error?.code).toBe('email_linked_to_other_provider');
    expect(error?.details).toEqual([
      { field: 'email', code: 'use_apple', message: 'Sign in with Apple instead.' },
    ]);
    expect(accounts.users.size).toBe(1);
  });

  it('refuses a suspended account and sends a pending-deletion one to restore_account', async () => {
    const { accounts, service } = setup();
    accounts.addUser({ status: 'suspended' }, [{ provider: 'google', subject: 'google-sub-1' }]);
    accounts.addUser({ status: 'pending_deletion' }, [{ provider: 'apple', subject: 'apple-2' }]);

    expect((await errorOf(service.signIn(base)))?.code).toBe('account_suspended');

    const result = await service.signIn({ ...base, provider: 'apple', subject: 'apple-2' });
    expect(result.status).toBe(200);
    expect(result.body.next_step).toBe('restore_account');
  });

  it('creates an account without an email (Apple relay edge case)', async () => {
    const { service } = setup();
    const result = await service.signIn({
      ...base,
      provider: 'apple',
      subject: 'apple-3',
      email: null,
      givenName: null,
    });
    expect(result.status).toBe(201);
    expect(result.body.user.first_name).toBe('New user');
  });
});
