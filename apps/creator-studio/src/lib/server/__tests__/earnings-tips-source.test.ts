import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sql: [] as string[], cacheNames: [] as string[] }));

vi.mock('$lib/server/cache', () => ({
  createCache: <A, R>({ name, fetch }: { name: string; fetch: (args: A) => Promise<R> }) => {
    state.cacheNames.push(name);
    return { get: fetch };
  },
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

const RECEIVING =
  "(type IN ('tip','compensation','licenseFee','27','sell')" +
  " OR (type = 'purchase' AND (externalTransactionId LIKE 'early-access-%' OR externalTransactionId LIKE 'permanent-access-%')))";

/** The parenthesised group opening at `start`, through its matching close paren. */
function group(sql: string, start: number) {
  let depth = 0;
  for (let i = start; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')' && --depth === 0) return sql.slice(start, i + 1);
  }
  throw new Error(`unbalanced group at ${start}`);
}
const sourceExpr = (sql: string) => group(sql, sql.indexOf('multiIf(') + 'multiIf'.length);

// DECISION (Justin, 2026-10-09): a `tip` from account 0 is not a tip, so it is kept off the Tips card,
// but it stays in the totals. Until 2025-10-13 the payout job paid generation tips that way (keyed
// `creator-tip-`); the rest are refunds and manual credits, some of them creator income, shown as
// Other credits. If you are about to drop account-0 tips from the receiving filter: that takes real
// payouts out of creators' totals.
describe('earnings: tips from account 0', () => {
  beforeEach(() => {
    state.sql = [];
  });

  it.each([
    ['summary', () => getEarningsSummary(args)],
    ['series', () => getEarningsSeries(args)],
    ['monthly', () => getMonthlyEarnings({ userId: 42 })],
  ])('the %s read still counts every tip row in the totals', async (_, read) => {
    await read();
    expect(state.sql).toHaveLength(1);
    const [sql] = state.sql;
    const start = sql.indexOf('(type IN (');

    expect(sql.slice(start - 5, start)).toBe(' AND ');
    expect(group(sql, start)).toBe(RECEIVING);
    expect(sql.indexOf('(type IN (', start + 1)).toBe(-1);
  });

  it('labels account-0 tips as generation tips or other credits before the user tip arm', async () => {
    await getEarningsSummary(args);

    expect(sourceExpr(state.sql[0])).toMatch(
      /^\(\(type = 'tip' AND fromAccountId = 0\) AND externalTransactionId LIKE 'creator-tip-%', 'generationTip', \(type = 'tip' AND fromAccountId = 0\), 'otherCredit', type = 'tip', 'tip', /
    );
  });

  it('labels a tip the same way in the summary and the trend', async () => {
    await getEarningsSummary(args);
    await getEarningsSeries(args);

    expect(sourceExpr(state.sql[1])).toBe(sourceExpr(state.sql[0]));
  });

  // The values cached before this change labelled refunds as tips.
  it('reads under cache keys newer than the ones that labelled refunds as tips', () => {
    expect(state.cacheNames).toEqual(
      expect.arrayContaining(['earnings:summary:v3', 'earnings:series:v4'])
    );
  });
});
