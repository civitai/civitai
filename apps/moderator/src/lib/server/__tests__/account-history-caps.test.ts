import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `AccountHistory` renders every count as `.length` over a list its query already capped, so on an
 * account past the cap the header stated the cap as the answer — and the activity list's
 * "Show all (N more)" derived N from the same truncated array, so expanding it said "Show fewer" with
 * nothing left. Both panels that render it are the screen where the next strike is decided, so
 * "this account has been enforced against 200 times" reading as complete when it is 341 is the one
 * wrong answer here that changes what a moderator does.
 *
 * The fix is a single extra row per source. Nothing downstream can tell the difference between a full
 * window and a truncated one on its own — the rows look identical — so these assert the two halves that
 * make it work: every source is ASKED for limit + 1, and the extra row is DROPPED before it renders.
 */

const calls = vi.hoisted(
  () => ({} as Record<string, { limit: number | undefined; count: number }>)
);
const rowsFor = vi.hoisted(() => ({
  strikes: 0,
  enforcement: 0,
  rating: 0,
  retool: 0,
  reports: 0,
}));

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

const record = (name: string, limit: number | undefined, n: number) => {
  calls[name] = { limit, count: (calls[name]?.count ?? 0) + 1 };
  return Promise.resolve(rows(n));
};

vi.mock('$lib/server/user-lookup.service', () => ({
  getLiveStrikes: (_id: number, opts?: { limit?: number }) =>
    record('strikes', opts?.limit, rowsFor.strikes),
}));

vi.mock('$lib/server/user-account.service', () => ({
  getModActivity: (_id: number, limit?: number, bucket?: string) =>
    record(
      bucket === 'rating' ? 'rating' : 'enforcement',
      limit,
      bucket === 'rating' ? rowsFor.rating : rowsFor.enforcement
    ),
  getRetoolActivity: (_id: number, limit?: number) => record('retool', limit, rowsFor.retool),
}));

vi.mock('$lib/server/user-reports.service', () => ({
  getReportsOnUser: (_id: number, opts?: { limit?: number }) =>
    record('reports', opts?.limit, rowsFor.reports),
}));

vi.mock('$lib/server/moderation-memory.service', () => ({
  getUserNotes: () => Promise.resolve([]),
}));

const { loadAccountHistory } = await import('../account-history');

describe('loadAccountHistory', () => {
  beforeEach(() => {
    for (const k of Object.keys(calls)) delete calls[k];
    Object.assign(rowsFor, { strikes: 0, enforcement: 0, rating: 0, retool: 0, reports: 0 });
  });

  it('asks every source for one row past the window', async () => {
    await loadAccountHistory(1, 'mod');

    // The caps themselves are the panel's definition of the question; the +1 is what lets it say so.
    expect(calls.strikes.limit).toBe(51);
    expect(calls.enforcement.limit).toBe(101);
    expect(calls.rating.limit).toBe(101);
    expect(calls.retool.limit).toBe(101);
    expect(calls.reports.limit).toBe(21);
  });

  it('drops the extra row rather than rendering it', async () => {
    // Leaking it would make the panel show 101 of a 100-row window — a cap that is off by one is worse
    // than a cap, because nothing about the number looks round enough to question.
    Object.assign(rowsFor, {
      strikes: 51,
      enforcement: 101,
      rating: 101,
      retool: 101,
      reports: 21,
    });

    const history = await loadAccountHistory(1, 'mod');

    expect(history.strikes).toHaveLength(50);
    expect(history.modActivity).toHaveLength(100);
    expect(history.ratingActivity).toHaveLength(100);
    expect(history.retoolActivity).toHaveLength(100);
    expect(history.reportsOnUser).toHaveLength(20);
  });

  it('reports truncation only when a source actually had more', async () => {
    Object.assign(rowsFor, {
      strikes: 50,
      enforcement: 100,
      rating: 100,
      retool: 100,
      reports: 20,
    });

    const full = await loadAccountHistory(1, 'mod');

    // Exactly at the cap is NOT truncated: an account with precisely 50 strikes must read "50", not
    // "50+". This is the boundary a `>=` would get wrong in the direction nobody checks.
    expect(full.truncated).toEqual({ strikes: false, activity: false, reports: false });
  });

  it('flags the merged activity list when ANY of its three sources was cut', async () => {
    // The panel renders one count over enforcement + rating + Retool, so a cap on the Retool half alone
    // still makes that one number a lie.
    Object.assign(rowsFor, { strikes: 0, enforcement: 5, rating: 5, retool: 101, reports: 0 });

    const history = await loadAccountHistory(1, 'mod');

    expect(history.truncated.activity).toBe(true);
    expect(history.truncated.strikes).toBe(false);
  });
});
