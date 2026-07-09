import { describe, it, expect, beforeEach, vi } from 'vitest';

// Magic-link tokens use a TTL grace window (NOT single-use): email scanners prefetch the link and would burn a
// one-shot token before the real click, so the token stays valid for its whole TTL and is only deleted once
// expired. We drive create/consume with a fake kysely `db` backed by an in-memory token store and assert: the
// create→consume round-trip (hash parity), reuse within the window, and expiry cleanup + rejection.
type Row = { identifier: string; token: string; expires: Date };
const h = vi.hoisted(() => ({
  tokens: [] as Row[],
  deletes: [] as string[], // tokens passed to deleteFrom(...).where('token', ...)
}));

vi.mock('../../db/db', () => {
  const db = {
    insertInto: () => ({
      values: (vals: Row) => ({
        execute: async () => {
          h.tokens.push(vals);
        },
      }),
    }),
    selectFrom: () => ({
      select: () => ({
        where: (_c: string, _op: string, identifier: string) => ({
          where: (_c2: string, _op2: string, token: string) => ({
            executeTakeFirst: async () => {
              const r = h.tokens.find((t) => t.identifier === identifier && t.token === token);
              return r ? { expires: r.expires } : undefined;
            },
          }),
        }),
      }),
    }),
    deleteFrom: () => ({
      where: (_c: string, _op: string, token: string) => ({
        execute: async () => {
          h.deletes.push(token);
          h.tokens = h.tokens.filter((t) => t.token !== token);
        },
      }),
    }),
  };
  return { db };
});

import { createVerificationToken, consumeVerificationToken } from '../email-tokens';

const EMAIL = 'user5@example.com';

beforeEach(() => {
  h.tokens = [];
  h.deletes = [];
  process.env.NEXTAUTH_SECRET = 'test-secret';
});

describe('email verification token — grace window', () => {
  it('create→consume round-trips (only the hash is stored; raw token validates)', async () => {
    const raw = await createVerificationToken(EMAIL);
    expect(h.tokens).toHaveLength(1);
    expect(h.tokens[0].token).not.toBe(raw); // stored value is the hash, not the raw token
    expect(await consumeVerificationToken(EMAIL, raw)).toBe(true);
  });

  it('stays valid for REPEATED clicks within the TTL (not single-use)', async () => {
    const raw = await createVerificationToken(EMAIL);
    expect(await consumeVerificationToken(EMAIL, raw)).toBe(true);
    expect(await consumeVerificationToken(EMAIL, raw)).toBe(true); // scanner prefetch + real click both pass
    expect(h.deletes).toHaveLength(0); // never consumed/deleted while valid
  });

  it('rejects an unknown / wrong token without deleting anything', async () => {
    await createVerificationToken(EMAIL);
    expect(await consumeVerificationToken(EMAIL, 'not-the-token')).toBe(false);
    expect(await consumeVerificationToken('other@example.com', 'whatever')).toBe(false);
    expect(h.deletes).toHaveLength(0);
  });

  it('rejects AND cleans up an expired token', async () => {
    // Seed an already-expired row directly (mirrors createVerificationToken's stored shape).
    const raw = await createVerificationToken(EMAIL);
    const stored = h.tokens[0];
    stored.expires = new Date(Date.now() - 1000); // force expiry

    expect(await consumeVerificationToken(EMAIL, raw)).toBe(false);
    expect(h.deletes).toEqual([stored.token]); // expired row pruned
    expect(h.tokens).toHaveLength(0);
  });
});
