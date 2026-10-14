// Magic links on the `magic_link_tokens` table (decision 51):
//
//   create    when the app asks for the email
//   peek      the browser page looks at the token before showing "confirm"
//   open      the person confirmed on the page: opened_at is set
//   findById  the app polls by the request id it was given
//   consume   the app's claim signs in: consumed_at is set, once
//
// Like refresh and guest tokens, only the SHA-256 hash of the token is
// stored. The row's own id doubles as the request id the app polls with; it
// is a UUID v7, so it is not guessable, and the claim route also checks that
// the polling install is the one that asked.

import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  generateMagicLinkToken,
  hashMagicLinkToken,
  MAGIC_LINK_LIFETIME_MS,
} from '../auth/magic-link-token.js';
import { AppError } from '../http/errors.js';
import type { Executor } from './idempotency-store.js';
import type { EnumValue } from './schema/enums.js';
import { type magicIntentEnum, magicLinkTokens } from './schema/index.js';

export type MagicIntent = EnumValue<typeof magicIntentEnum>;

// MagicLinkRequest is what we know when the email is asked for: the address,
// the intent (sign_in or sign_up), the guest session, the device that asked,
// the IP. MagicLink is a row as the rest of the code sees it.
export interface MagicLinkRequest {
  email: string;
  intent: MagicIntent;
  guestSessionId: string | null;
  requestedDeviceId: string;
  requestedIp: string | null;
}

export interface MagicLink {
  id: string;
  email: string;
  intent: MagicIntent;
  guestSessionId: string | null;
  requestedDeviceId: string | null;
  expiresAt: Date;
  openedAt: Date | null;
  consumedAt: Date | null;
}

export interface IssuedMagicLink {
  link: MagicLink;
  // The one time the token is seen in the clear; it goes into the email.
  token: string;
}

export interface MagicLinkStore {
  create(request: MagicLinkRequest, now: Date): Promise<IssuedMagicLink>;
  // The live link behind a token, without changing it. Throws
  // magic_link_invalid, magic_link_already_used or magic_link_expired.
  peek(token: string, now: Date): Promise<MagicLink>;
  // Marks the link opened (the person confirmed in the browser). Same errors
  // as peek. Opening an already opened link is fine and changes nothing.
  open(token: string, now: Date): Promise<MagicLink>;
  // The link by its id, whatever state it is in; undefined when unknown.
  findById(id: string): Promise<MagicLink | undefined>;
  // Uses the link up, by id. Throws magic_link_already_used on a second call,
  // magic_link_expired when late, magic_link_invalid when the row is gone.
  consume(id: string, now: Date): Promise<MagicLink>;
  // Undoes a create whose email could not be sent.
  delete(linkId: string): Promise<void>;
  // Purge job: removes links that expired before `before`, used or not.
  // Resolves to how many.
  deleteExpired(before: Date): Promise<number>;
}

type Row = typeof magicLinkTokens.$inferSelect;
type RowFields = Pick<
  Row,
  | 'id'
  | 'email'
  | 'intent'
  | 'guestSessionId'
  | 'requestedDeviceId'
  | 'expiresAt'
  | 'openedAt'
  | 'consumedAt'
>;

const toMagicLink = (row: RowFields): MagicLink => ({
  id: row.id,
  email: row.email,
  intent: row.intent,
  guestSessionId: row.guestSessionId,
  requestedDeviceId: row.requestedDeviceId,
  expiresAt: row.expiresAt,
  openedAt: row.openedAt,
  consumedAt: row.consumedAt,
});

// The three refusals, in the order they are checked.
function assertLive(row: RowFields | undefined, now: Date): asserts row is RowFields {
  if (row === undefined) throw new AppError('magic_link_invalid');
  if (row.consumedAt !== null) throw new AppError('magic_link_already_used');
  if (row.expiresAt <= now) throw new AppError('magic_link_expired');
}

export function createMagicLinkStore(db: Executor): MagicLinkStore {
  const byHash = (token: string) =>
    db.query.magicLinkTokens.findFirst({
      where: eq(magicLinkTokens.tokenHash, hashMagicLinkToken(token)),
    });
  const byId = (id: string) =>
    db.query.magicLinkTokens.findFirst({ where: eq(magicLinkTokens.id, id) });

  return {
    // Generate the token, insert the row with its hash and
    // expires_at = now + 15 min, return the row and the token.
    async create(request, now) {
      const token = generateMagicLinkToken();
      const [row] = await db
        .insert(magicLinkTokens)
        .values({
          email: request.email,
          tokenHash: hashMagicLinkToken(token),
          intent: request.intent,
          guestSessionId: request.guestSessionId,
          requestedDeviceId: request.requestedDeviceId,
          requestedIp: request.requestedIp,
          expiresAt: new Date(now.getTime() + MAGIC_LINK_LIFETIME_MS),
        })
        .returning();
      if (row === undefined) throw new Error('magic link insert returned no row');
      return { link: toMagicLink(row), token };
    },

    async peek(token, now) {
      const row = await byHash(token);
      assertLive(row, now);
      return toMagicLink(row);
    },

    async open(token, now) {
      const row = await byHash(token);
      assertLive(row, now);
      if (row.openedAt !== null) return toMagicLink(row);

      // Only the first confirm sets the time; a second one at the same
      // moment loses the race and keeps the first value.
      const [opened] = await db
        .update(magicLinkTokens)
        .set({ openedAt: now })
        .where(and(eq(magicLinkTokens.id, row.id), isNull(magicLinkTokens.openedAt)))
        .returning();
      return toMagicLink(opened ?? { ...row, openedAt: now });
    },

    async findById(id) {
      const row = await byId(id);
      return row === undefined ? undefined : toMagicLink(row);
    },

    async consume(id, now) {
      // One statement marks the link used only if it is live and not used
      // yet, so of two simultaneous claims exactly one gets the row back.
      const [consumed] = await db
        .update(magicLinkTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(magicLinkTokens.id, id),
            isNull(magicLinkTokens.consumedAt),
            gt(magicLinkTokens.expiresAt, now),
          ),
        )
        .returning();

      if (consumed === undefined) {
        // Nothing matched: unknown, used, or expired. assertLive tells which.
        const row = await byId(id);
        assertLive(row, now);
        // Reached only if the row became live between the two statements,
        // which cannot happen; keep the type checker satisfied.
        throw new AppError('magic_link_invalid');
      }
      return toMagicLink(consumed);
    },

    async delete(linkId) {
      await db.delete(magicLinkTokens).where(eq(magicLinkTokens.id, linkId));
    },

    async deleteExpired(before) {
      const deleted = await db
        .delete(magicLinkTokens)
        .where(lt(magicLinkTokens.expiresAt, before))
        .returning({ id: magicLinkTokens.id });
      return deleted.length;
    },
  };
}

// In-memory store with the same rules, for the route tests.
export function memoryMagicLinkStore(): MagicLinkStore {
  const rows = new Map<string, MagicLink & { tokenHash: string }>();
  const byHash = (token: string) => {
    const hash = hashMagicLinkToken(token);
    return [...rows.values()].find((row) => row.tokenHash === hash);
  };
  // Turns a thrown AppError into a rejected promise, like the real store.
  const attempt = <T>(run: () => T): Promise<T> => {
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  return {
    create(request, now) {
      const token = generateMagicLinkToken();
      const row = {
        id: uuidv7(),
        email: request.email,
        tokenHash: hashMagicLinkToken(token),
        intent: request.intent,
        guestSessionId: request.guestSessionId,
        requestedDeviceId: request.requestedDeviceId,
        expiresAt: new Date(now.getTime() + MAGIC_LINK_LIFETIME_MS),
        openedAt: null,
        consumedAt: null,
      };
      rows.set(row.id, row);
      return Promise.resolve({ link: toMagicLink(row), token });
    },
    peek(token, now) {
      return attempt(() => {
        const row = byHash(token);
        assertLive(row, now);
        return toMagicLink(row);
      });
    },
    open(token, now) {
      return attempt(() => {
        const row = byHash(token);
        assertLive(row, now);
        row.openedAt ??= now;
        return toMagicLink(row);
      });
    },
    findById(id) {
      const row = rows.get(id);
      return Promise.resolve(row === undefined ? undefined : toMagicLink(row));
    },
    consume(id, now) {
      return attempt(() => {
        const row = rows.get(id);
        assertLive(row, now);
        row.consumedAt = now;
        return toMagicLink(row);
      });
    },
    delete(linkId) {
      rows.delete(linkId);
      return Promise.resolve();
    },
    deleteExpired(before) {
      let deleted = 0;
      for (const [id, row] of rows) {
        if (row.expiresAt < before) {
          rows.delete(id);
          deleted += 1;
        }
      }
      return Promise.resolve(deleted);
    },
  };
}
