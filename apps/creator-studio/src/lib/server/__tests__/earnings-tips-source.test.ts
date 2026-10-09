import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sql: [] as string[] }));

vi.mock('$lib/server/cache', () => ({
  createCache: <A, R>({ fetch }: { fetch: (args: A) => Promise<R> }) => ({ get: fetch }),
}));
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (sql: string) => {
      state.sql.push(sql);
      return [];
    },
  }),
}));

const { getEarningsSummary, getEarningsSeries, getMonthlyEarnings } = await import('../earnings');

const args = { userId: 42, from: '2026-09-01', to: '2026-09-30' };

// DECISION: a `tip` from account 0 is not a tip. On prod those rows are support refunds, deposit
// reconciliations and other manual credits (about 9.6M Buzz since 2025-09), except the generation tips
// the payout job paid that way until 2025-10-13 (keyed `creator-tip-`), which are earnings. If you are
// about to put 'tip' back in the plain type list: the Tips card then counts refunds as tips again.
describe('earnings: tips from account 0', () => {
  beforeEach(() => {
    state.sql = [];
  });

  it.each([
    ['summary', () => getEarningsSummary(args)],
    ['series', () => getEarningsSeries(args)],
    ['monthly', () => getMonthlyEarnings({ userId: 42 })],
  ])('the %s read counts only user tips and the pre-split generation tips', async (_, read) => {
    await read();
    const [sql] = state.sql;
    const receiving = sql.slice(sql.indexOf('(type IN ('));

    expect(receiving).toMatch(
      /^\(type IN \('compensation','licenseFee','27','sell'\) OR \(type = 'tip' AND fromAccountId != 0\) OR \(type = 'tip' AND fromAccountId = 0 AND externalTransactionId LIKE 'creator-tip-%'\) OR \(type = 'purchase' AND /
    );
  });

  it('labels the pre-split generation tips as generation tips, ahead of the plain tip arm', async () => {
    await getEarningsSummary(args);

    expect(state.sql[0]).toContain(
      `SELECT multiIf((type = 'tip' AND fromAccountId = 0 AND externalTransactionId LIKE 'creator-tip-%'), 'generationTip', type = 'tip', 'tip',`
    );
  });
});
