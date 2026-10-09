// create at sign-in, rotate at refresh, revoke at log out, and revokeAllForUser for log-out-everywhere and account deletion.
//
// Rotation and reuse: each refresh replaces the token. The row keeps the hash of the token /it just replaced in `previous_refresh_token_hash`. If that old token ever comes
// back, someone has a copy they should not have (or the phone lost the new
// one), and the only safe answer is to end the session for both of them.

import { and, eq, isNull, or } from 'drizzle-orm';
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_LIFETIME_MS,
} from '../auth/refresh-token.js';
import { AppError } from '../http/errors.js';
import type { Database } from './idempotency-store.js';
import { sessions } from './schema/index.js';

export interface Session {
  id: string;
  userId: string;
  deviceId: string;
  expiresAt: Date;
}

// A session plus the one-time chance to see its refresh token in the clear.
export interface IssuedSession {
  session: Session;
  refreshToken: string;
}

export interface SessionStore {
  // Sign-in: a new session for this user on this device.
  create(userId: string, deviceId: string, now: Date): Promise<IssuedSession>;
  // Refresh: swap the token for a new one and extend the session.
  rotate(refreshToken: string, now: Date): Promise<IssuedSession>;
  // Log out. Revoking twice is harmless.
  revoke(sessionId: string, now: Date): Promise<void>;
  // Log out everywhere, account deletion, suspension. Returns how many were live.
  revokeAllForUser(userId: string, now: Date): Promise<number>;
}

//shape of one row from the sessions table
type Row = typeof sessions.$inferSelect;

//function that takes a full row and returns only the 4 fields the rest of the app should see
const toSession = (row: Row): Session => ({
  id: row.id,
  userId: row.userId,
  deviceId: row.deviceId,
  expiresAt: row.expiresAt,
});

// What the rotation transaction decides; the error is thrown after commit.
type RotationOutcome =
  { kind: 'rotated'; issued: IssuedSession } | { kind: 'reused' } | { kind: 'unknown' };

export function createSessionStore(db: Database): SessionStore {
  return {
    async create(userId, deviceId, now) {
      const refreshToken = generateRefreshToken();
      const [row] = await db
        .insert(sessions)
        .values({
          userId,
          deviceId,
          refreshTokenHash: hashRefreshToken(refreshToken),
          expiresAt: new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
        })
        .returning();
      if (row === undefined) throw new Error('session insert returned no row');
      return { session: toSession(row), refreshToken };
    },

    //tx is the database handle for this transaction; if the function throws, every write inside is undone
    async rotate(refreshToken, now) {
      const hash = hashRefreshToken(refreshToken);
      //Find the one session row that this token belongs to. The token could be the row's current one, or the one the row just replaced, so it checks both columns
      const outcome = await db.transaction(async (tx): Promise<RotationOutcome> => {
        const [row] = await tx
          .select()
          .from(sessions)
          .where(
            or(eq(sessions.refreshTokenHash, hash), eq(sessions.previousRefreshTokenHash, hash)),
          )
          .for('update');

        //is this session dead?
        if (row === undefined || row.revokedAt !== null || row.expiresAt <= now) {
          return { kind: 'unknown' };
        }

        // is this the token that was already used
        if (row.previousRefreshTokenHash === hash) {
          await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, row.id));
          return { kind: 'reused' };
        }

        const next = generateRefreshToken();
        const [updated] = await tx
          .update(sessions)
          .set({
            refreshTokenHash: hashRefreshToken(next),
            previousRefreshTokenHash: hash,
            expiresAt: new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
          })
          .where(eq(sessions.id, row.id))
          .returning();
        if (updated === undefined) throw new Error('session update returned no row');
        return { kind: 'rotated', issued: { session: toSession(updated), refreshToken: next } };
      });

      switch (outcome.kind) {
        case 'rotated':
          return outcome.issued;
        case 'reused':
          throw new AppError('refresh_token_reused');
        case 'unknown':
          throw new AppError('unauthenticated');
      }
    },

    async revoke(sessionId, now) {
      await db
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
    },

    async revokeAllForUser(userId, now) {
      const revoked = await db
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      return revoked.length;
    },
  };
}
