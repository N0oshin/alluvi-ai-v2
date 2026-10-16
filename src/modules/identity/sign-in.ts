// The sign-in rules shared by Apple, Google and the email magic link. Each
// route proves *who* is calling (a verified identity token, a consumed magic
// link) and hands the result here. This file decides what happens next:
//
//   1. The identity is already linked to an account: sign that user in.
//   2. It is not, but the verified email belongs to an account: refuse with
//      409 and name the method that account uses.
//   3. Otherwise create the account, which needs the terms consent.
//
// No HTTP here: the routes turn the result into a response.

import { ACCESS_TOKEN_LIFETIME_SECONDS, accessTokens } from '../../shared/auth/access-token.js';
import { AppError } from '../../shared/http/errors.js';
import {
  type AuthProvider,
  type ConsentDecision,
  createAccount,
  findUserByEmail,
  findUserByIdentity,
  openSession,
  providersOf,
  type UserRecord,
} from './queries.js';

export interface SignInInput {
  provider: AuthProvider;
  // Apple's and Google's `sub`, or the lower-cased address for email.
  subject: string;
  // The address the provider vouches for; null when it gave none.
  email: string | null;
  givenName: string | null;
  familyName: string | null;
  consents: ConsentDecision[];
  guestSessionId: string | null;
  deviceId: string;
  timeZone: string;
  ip: string | null;
}

// Where the app goes after sign-in (document 02 section 4.1).
export type NextStep =
  'confirm_name' | 'create_username' | 'add_photo' | 'home' | 'restore_account';

// The response body, in the API's snake_case.
export interface SignInBody {
  access_token: string;
  access_expires_in: number;
  refresh_token: string;
  user: { id: string; first_name: string; username: string | null };
  is_new_user: boolean;
  next_step: NextStep;
}

export interface SignInResult {
  // 201 for a new account, 200 for an existing one.
  status: 200 | 201;
  body: SignInBody;
}

export function nextStepFor(user: UserRecord, isNewUser: boolean): NextStep {
  if (user.status === 'pending_deletion') return 'restore_account';
  if (isNewUser) return 'confirm_name';
  if (user.username === null) return 'create_username';
  if (user.onboardingCompletedAt === null) return 'add_photo';
  return 'home';
}

export function initialFirstName(givenName: string | null, email: string | null): string {
  const given = givenName?.trim();
  if (given) return given.slice(0, 50);
  const local = email?.split('@')[0]?.trim();
  if (local) return local.slice(0, 50);
  return 'New user';
}

function hasTermsConsent(consents: ConsentDecision[]): boolean {
  return consents.some((c) => c.type === 'terms_and_privacy' && c.granted);
}

function describe(provider: AuthProvider): string {
  switch (provider) {
    case 'apple':
      return 'Apple';
    case 'google':
      return 'Google';
    case 'email':
      return 'your email';
  }
}

async function respond(
  user: UserRecord,
  refreshToken: string,
  sessionId: string,
  isNewUser: boolean,
): Promise<SignInResult> {
  const accessToken = await accessTokens.issue({ userId: user.id, sessionId });
  return {
    status: isNewUser ? 201 : 200,
    body: {
      access_token: accessToken,
      access_expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      refresh_token: refreshToken,
      user: { id: user.id, first_name: user.firstName, username: user.username },
      is_new_user: isNewUser,
      next_step: nextStepFor(user, isNewUser),
    },
  };
}

export async function signIn(input: SignInInput, now: Date = new Date()): Promise<SignInResult> {
  const identity = { provider: input.provider, subject: input.subject };

  // 1. A known identity.
  const existing = await findUserByIdentity(identity.provider, identity.subject);
  if (existing !== undefined) {
    if (existing.status === 'suspended') throw new AppError('account_suspended');
    // A purged account's identity should be gone; if one lingers, it cannot
    // sign in.
    if (existing.status === 'deleted') throw new AppError('unauthenticated');

    const issued = await openSession(
      existing.id,
      identity,
      input.deviceId,
      input.guestSessionId,
      now,
    );
    return respond(existing, issued.refreshToken, issued.session.id, false);
  }

  // 2. The email is taken by an account that signs in another way.
  if (input.email !== null) {
    const owner = await findUserByEmail(input.email);
    if (owner !== undefined) {
      const providers = await providersOf(owner.id);
      throw new AppError(
        'email_linked_to_other_provider',
        providers.map((provider) => ({
          field: 'email',
          code: `use_${provider}`,
          message: `Sign in with ${describe(provider)} instead.`,
        })),
      );
    }
  }

  // 3. A new account.
  if (!hasTermsConsent(input.consents)) throw new AppError('consent_required');

  const created = await createAccount(
    {
      user: {
        email: input.email,
        firstName: initialFirstName(input.givenName, input.email),
        lastName: input.familyName?.trim().slice(0, 50) || null,
        timeZone: input.timeZone,
      },
      identity: { ...identity, emailAtProvider: input.email },
      consents: input.consents,
      deviceId: input.deviceId,
      guestSessionId: input.guestSessionId,
      ip: input.ip,
    },
    now,
  );
  return respond(created.user, created.session.refreshToken, created.session.session.id, true);
}
