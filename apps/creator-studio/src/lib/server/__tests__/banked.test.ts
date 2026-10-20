import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as { accountId: number; opts: unknown }[],
  balances: {} as Record<string, number>,
}));

vi.mock('$lib/server/cache', () => ({
  createCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
}));

vi.mock('$lib/server/buzz', () => ({
  getBuzz: () => ({
    getCounterparties: async (
      accountId: number,
      opts: { query: { accountId: number; accountType: string } }
    ) => {
      state.calls.push({ accountId, opts });
      return { totalBalance: state.balances[opts.query.accountType] ?? 0 };
    },
  }),
}));

import { getBanked } from '../banked';

describe('getBanked', () => {
  beforeEach(() => {
    state.calls = [];
    state.balances = {};
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("sums the creator's yellow and green deposits in this month's bank, leaving blue out", async () => {
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
    state.balances = { yellow: 12_000, green: 3_500, blue: 900 };

    expect(await getBanked({ userId: 42 })).toBe(15_500);
    expect(state.calls).toEqual(
      ['yellow', 'green'].map((accountType) => ({
        accountId: 202610,
        opts: { accountType: 'creatorProgramBank', query: { accountId: 42, accountType } },
      }))
    );
  });

  it('reads the UTC month whatever zone the server runs in', async () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Chicago';
    try {
      // Still Oct 31 in Chicago (CDT, UTC-5), already November in UTC.
      vi.setSystemTime(new Date('2026-10-31T23:30:00-05:00'));

      await getBanked({ userId: 42 });
      expect(state.calls.map((c) => c.accountId)).toEqual([202611, 202611]);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});
