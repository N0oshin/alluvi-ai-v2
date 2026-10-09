// Magic links on the `magic_link_tokens` table: create when the email is
// requested, peek and consume when the app opens the link.
//
// Like refresh and guest tokens, only the SHA-256 hash is stored. A link is single use: `consume` marks it with one

import { and, eq, isNull } from 'drizzle-orm';
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

//MagicLinkRequest is what we know when the email is asked for: the address, the intent (sign_in or sign_up), the guest session, the device that asked, the IP. MagicLink is a row as the rest of the code sees it
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
  consumedAt: Date | null;
}

export interface IssuedMagicLink {
  link: MagicLink;
  // The one time the token is seen in the clear; it goes into the email.
  token: string;
}

export interface MagicLinkStore {
  create(request: MagicLinkRequest, now: Date): Promise<IssuedMagicLink>;
  // The live link behind a token, without using it up. Throws
  // magic_link_invalid, magic_link_expired or magic_link_already_used.
  peek(token: string, now: Date): Promise<MagicLink>;
  // Uses the link up. Same errors as peek; a second consume is already_used.
  consume(token: string, now: Date): Promise<MagicLink>;
  // Undoes a create whose email could not be sent.
  delete(linkId: string): Promise<void>;
}

type Row = typeof magicLinkTokens.$inferSelect;
type RowFields = Pick<
  Row,
  'id' | 'email' | 'intent' | 'guestSessionId' | 'requestedDeviceId' | 'expiresAt' | 'consumedAt'
>;

const toMagicLink = (row: RowFields): MagicLink => ({
  id: row.id,
  email: row.email,
  intent: row.intent,
  guestSessionId: row.guestSessionId,
  requestedDeviceId: row.requestedDeviceId,
  expiresAt: row.expiresAt,
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

  return {
    //Generate the token, insert the row with its hash and expires_at = now + 15 min, return the row and the token.
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

    async consume(token, now) {
      // One statement marks the link used only if it is not used yet, so of
      // two simultaneous opens exactly one gets the row back.
      const [consumed] = await db
        .update(magicLinkTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(magicLinkTokens.tokenHash, hashMagicLinkToken(token)),
            isNull(magicLinkTokens.consumedAt),
          ),
        )
        .returning();

      if (consumed === undefined) {
        // Nothing matched: unknown, or already used. assertLive tells which.
        const row = await byHash(token);
        assertLive(row, now);
        // Reached only if the row became live between the two statements,
        // which cannot happen; keep the type checker satisfied.
        throw new AppError('magic_link_invalid');
      }
      if (consumed.expiresAt <= now) throw new AppError('magic_link_expired');
      return toMagicLink(consumed);
    },

    async delete(linkId) {
      await db.delete(magicLinkTokens).where(eq(magicLinkTokens.id, linkId));
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
        consumedAt: null,
      };
      rows.set(row.id, row);
      return Promise.resolve({ link: toMagicLink(row), token });
    },
    peek(token, now) {
      try {
        const row = byHash(token);
        assertLive(row, now);
        return Promise.resolve(toMagicLink(row));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    consume(token, now) {
      try {
        const row = byHash(token);
        assertLive(row, now);
        row.consumedAt = now;
        return Promise.resolve(toMagicLink(row));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    delete(linkId) {
      rows.delete(linkId);
      return Promise.resolve();
    },
  };
}
