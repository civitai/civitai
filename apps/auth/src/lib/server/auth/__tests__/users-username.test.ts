import { describe, it, expect, vi, beforeEach } from 'vitest';

// Username assignment lives in the (private) assignUsername, reachable only through
// findOrCreateUserByEmail / findOrCreateUser. We drive it via findOrCreateUserByEmail (the
// simplest provisioning path) with a fake kysely `db`, asserting the exact username string the
// generator writes (sanitized seed + 3-digit suffix), its collision-retry, seed fallthrough, and
// the random fallback. `./session`'s toSessionUser is stubbed (irrelevant to username math).
const h = vi.hoisted(() => ({
  // captures every username passed to updateTable('User').set({ username })
  usernameUpdates: [] as string[],
  // when true, that (0-based, per-test) username update attempt throws (a unique-constraint collision)
  failUpdate: (() => false) as (username: string, n: number) => boolean,
  existingUserId: undefined as number | undefined,
  // per-test counter of username write attempts — reset in beforeEach so `n` is deterministic
  updateN: 0,
}));

vi.mock('../session', () => ({
  toSessionUser: (row: { id: number; username: string | null }) => ({
    id: row.id,
    username: row.username ?? undefined,
  }),
}));

vi.mock('../../db/db', () => {
  const userRow: { id: number; username: string | null } = { id: 1, username: null };
  const db = {
    selectFrom: (_table: string) => ({
      select: () => ({
        where: () => ({
          // findOrCreateUserByEmail's "match by email" probe
          executeTakeFirst: async () =>
            h.existingUserId != null ? { id: h.existingUserId } : undefined,
        }),
      }),
      selectAll: () => ({
        where: () => ({
          // read-back after assignment — return the latest username we recorded
          executeTakeFirstOrThrow: async () => ({
            ...userRow,
            username: h.usernameUpdates.at(-1) ?? null,
          }),
        }),
      }),
    }),
    insertInto: () => ({
      values: () => ({
        returning: () => ({ executeTakeFirstOrThrow: async () => ({ id: userRow.id }) }),
        execute: async () => [],
      }),
    }),
    updateTable: (_table: string) => ({
      set: (vals: { username?: string; emailVerified?: unknown }) => ({
        where: () => ({
          where: () => ({ execute: async () => [] }), // the emailVerified "mark verified" path
          execute: async () => {
            // the assignUsername path: set({ username }).where('id', ...).execute()
            const username = vals.username!;
            const n = h.updateN++;
            if (h.failUpdate(username, n)) throw new Error('duplicate key value (username)');
            h.usernameUpdates.push(username);
          },
        }),
      }),
    }),
  };
  return { db };
});

import { findOrCreateUserByEmail } from '../users';

beforeEach(() => {
  h.usernameUpdates = [];
  h.failUpdate = () => false;
  h.existingUserId = undefined; // force the "create new user" branch
  h.updateN = 0; // deterministic attempt index per test
});

describe('username candidate generation', () => {
  it('sanitizes the email local-part and appends a 3-digit suffix', async () => {
    await findOrCreateUserByEmail('Al.ice+tag@example.com');
    expect(h.usernameUpdates).toHaveLength(1);
    // local-part 'Al.ice+tag' → strip non-[A-Za-z0-9_] → 'Alicetag'
    expect(h.usernameUpdates[0]).toMatch(/^Alicetag\d{3}$/);
    const n = Number(h.usernameUpdates[0].slice('Alicetag'.length));
    expect(n).toBeGreaterThanOrEqual(100);
    expect(n).toBeLessThanOrEqual(999);
  });

  it('retries the SAME seed with a fresh suffix on a single collision', async () => {
    let first = true;
    h.failUpdate = () => {
      if (first) {
        first = false;
        return true; // 1st attempt collides
      }
      return false;
    };
    await findOrCreateUserByEmail('bob@example.com');
    expect(h.usernameUpdates).toHaveLength(1); // only the successful write is recorded
    expect(h.usernameUpdates[0]).toMatch(/^bob\d{3}$/); // still the bob seed, not the fallback
  });

  it('falls through to the random fallback seed when the email seed exhausts both retries', async () => {
    // First seed 'bob' fails both attempts (attempts 0 and 1); the fallback seed succeeds.
    h.failUpdate = (_u, n) => n < 2;
    await findOrCreateUserByEmail('bob@example.com');
    expect(h.usernameUpdates).toHaveLength(1);
    // fallback shape: 5-char base + '_' + 3-digit suffix (generateToken(5)+'_')
    expect(h.usernameUpdates[0]).toMatch(/^[A-Za-z0-9]{1,5}_\d{3}$/);
    expect(h.usernameUpdates[0]).not.toMatch(/^bob/);
  });

  it('uses the random fallback when the seed sanitizes to empty', async () => {
    // local-part '+++' → sanitizes to '' → dropped → only the random fallback remains
    await findOrCreateUserByEmail('+++@example.com');
    expect(h.usernameUpdates).toHaveLength(1);
    expect(h.usernameUpdates[0]).toMatch(/^[A-Za-z0-9]{1,5}_\d{3}$/);
  });

  it('leaves the username unset (no throw) when even the fallback collides twice', async () => {
    h.failUpdate = () => true; // every write collides
    const u = await findOrCreateUserByEmail('bob@example.com');
    // assignUsername gives up silently rather than throwing; read-back returns null → undefined
    expect(h.usernameUpdates).toHaveLength(0);
    expect(u.username).toBeUndefined();
  });

  it('does NOT assign a username for an already-existing user', async () => {
    h.existingUserId = 42; // email already maps to a user
    await findOrCreateUserByEmail('bob@example.com');
    expect(h.usernameUpdates).toHaveLength(0);
  });
});
