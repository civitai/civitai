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
  "(type IN ('compensation','licenseFee','27','sell')" +
  " OR (type = 'tip' AND fromAccountId != 0)" +
  " OR (type = 'tip' AND fromAccountId = 0 AND externalTransactionId LIKE 'creator-tip-%')" +
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

// DECISION: a `tip` from account 0 is not a tip. On prod those rows are support refunds, deposit
// reconciliations and other manual credits, except the generation tips the payout job paid that way
// until 2025-10-13 (keyed `creator-tip-`), which are earnings. If you are about to put 'tip' back in
// the plain type list: the Tips card then counts refunds as tips again.
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
    expect(state.sql).toHaveLength(1);
    const [sql] = state.sql;
    const start = sql.indexOf('(type IN (');

    expect(sql.slice(start - 5, start)).toBe(' AND ');
    expect(group(sql, start)).toBe(RECEIVING);
    expect(sql.indexOf('(type IN (', start + 1)).toBe(-1);
  });

  it('labels the pre-split generation tips as generation tips, ahead of the plain tip arm', async () => {
    await getEarningsSummary(args);

    expect(state.sql[0]).toContain(
      `SELECT multiIf((type = 'tip' AND fromAccountId = 0 AND externalTransactionId LIKE 'creator-tip-%'), 'generationTip', type = 'tip', 'tip',`
    );
  });

  it('labels a tip the same way in the summary and the trend', async () => {
    await getEarningsSummary(args);
    await getEarningsSeries(args);
    const sourceExpr = (sql: string) => group(sql, sql.indexOf('multiIf(') + 'multiIf'.length);

    expect(sourceExpr(state.sql[1])).toBe(sourceExpr(state.sql[0]));
  });

  // The values cached before this change counted refunds as tips.
  it('reads under cache keys newer than the ones that counted refunds', () => {
    expect(state.cacheNames).toEqual(
      expect.arrayContaining(['earnings:summary:v3', 'earnings:series:v4', 'earnings:monthly:v2'])
    );
  });
});
