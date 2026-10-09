// Guest sessions on the `guest_sessions` table: create on first launch,
// resolve a guest token on each onboarding request, claim at sign-in.
//
// A guest session is the owner of the onboarding answers until an account
// exists. Claiming it hands those answers to the
// new user and ends the guest token: a claimed session no longer resolves, so
// it cannot be claimed twice

import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  generateGuestToken,
  GUEST_TOKEN_LIFETIME_MS,
  hashGuestToken,
} from '../auth/guest-token.js';
import { AppError } from '../http/errors.js';
import type { Executor } from './idempotency-store.js';
import { guestSessions } from './schema/index.js';

export interface GuestSession {
  id: string;
  deviceId: string;
  claimedByUserId: string | null;
  expiresAt: Date;
}

export interface IssuedGuestSession {
  guestSession: GuestSession;
  guestToken: string;
}

export interface GuestSessionStore {
  // First launch: a new guest session for this device.
  create(deviceId: string, now: Date): Promise<IssuedGuestSession>;
  // Every onboarding request: the live, unclaimed session behind a token.
  resolve(guestToken: string, now: Date): Promise<GuestSession>;
  // Sign-in: attach the session to the new user, once.
  claim(guestSessionId: string, userId: string, now: Date): Promise<GuestSession>;
}

type Row = typeof guestSessions.$inferSelect;

// Only the four fields it reads, so a row without timestamps (the memory
// store below) is accepted too. `Pick` is TypeScript notes entry 32.
type RowFields = Pick<Row, 'id' | 'deviceId' | 'claimedByUserId' | 'expiresAt'>;

const toGuestSession = (row: RowFields): GuestSession => ({
  id: row.id,
  deviceId: row.deviceId,
  claimedByUserId: row.claimedByUserId,
  expiresAt: row.expiresAt,
});

export function createGuestSessionStore(db: Executor): GuestSessionStore {
  return {
    async create(deviceId, now) {
      const guestToken = generateGuestToken();
      const [row] = await db
        .insert(guestSessions)
        .values({
          deviceId,
          tokenHash: hashGuestToken(guestToken),
          expiresAt: new Date(now.getTime() + GUEST_TOKEN_LIFETIME_MS),
        })
        .returning();
      if (row === undefined) throw new Error('guest session insert returned no row');
      return { guestSession: toGuestSession(row), guestToken };
    },

    async resolve(guestToken, now) {
      const row = await db.query.guestSessions.findFirst({
        where: eq(guestSessions.tokenHash, hashGuestToken(guestToken)),
      });
      if (row === undefined || row.claimedByUserId !== null || row.expiresAt <= now) {
        throw new AppError('unauthenticated');
      }
      return toGuestSession(row);
    },

    async claim(guestSessionId, userId, now) {
      // One statement claims only if still unclaimed, so two sign-ins racing
      // for the same session cannot both win: the update matches one row for
      // the first and none for the second.
      const [claimed] = await db
        .update(guestSessions)
        .set({ claimedByUserId: userId })
        .where(and(eq(guestSessions.id, guestSessionId), isNull(guestSessions.claimedByUserId)))
        .returning();

      if (claimed !== undefined) {
        // If the session had expired, we put the owner back to null and refuse with 401. A guest who waited more than 30 days starts over. Otherwise, success:
        if (claimed.expiresAt <= now) {
          await db
            .update(guestSessions)
            .set({ claimedByUserId: null })
            .where(eq(guestSessions.id, guestSessionId));
          throw new AppError('unauthenticated');
        }
        return toGuestSession(claimed);
      }

      // Nothing matched: either already claimed, or no such session.
      const existing = await db.query.guestSessions.findFirst({
        where: eq(guestSessions.id, guestSessionId),
      });
      throw new AppError(existing === undefined ? 'unauthenticated' : 'conflict');
    },
  };
}

// In-memory store with the same rules, for tests and for running the app
// without a database.
export function memoryGuestSessionStore(): GuestSessionStore {
  const rows = new Map<string, GuestSession & { tokenHash: string }>();

  return {
    create(deviceId, now) {
      const guestToken = generateGuestToken();
      const row = {
        id: uuidv7(),
        deviceId,
        tokenHash: hashGuestToken(guestToken),
        claimedByUserId: null,
        expiresAt: new Date(now.getTime() + GUEST_TOKEN_LIFETIME_MS),
      };
      rows.set(row.id, row);
      return Promise.resolve({ guestSession: toGuestSession(row), guestToken });
    },

    resolve(guestToken, now) {
      const hash = hashGuestToken(guestToken);
      const row = [...rows.values()].find((candidate) => candidate.tokenHash === hash);
      if (row === undefined || row.claimedByUserId !== null || row.expiresAt <= now) {
        return Promise.reject(new AppError('unauthenticated'));
      }
      return Promise.resolve(toGuestSession(row));
    },

    claim(guestSessionId, userId, now) {
      const row = rows.get(guestSessionId);
      if (row === undefined || row.expiresAt <= now) {
        return Promise.reject(new AppError('unauthenticated'));
      }
      if (row.claimedByUserId !== null) {
        return Promise.reject(new AppError('conflict'));
      }
      row.claimedByUserId = userId;
      return Promise.resolve(toGuestSession(row));
    },
  };
}
