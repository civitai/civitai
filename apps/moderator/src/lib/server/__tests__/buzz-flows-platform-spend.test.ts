import { beforeEach, describe, expect, it, vi } from 'vitest';

// The fake answers each query by its shape: the per-account summary is the one grouped by uid.
let summaryRows: Record<string, unknown>[] = [];
const queries: string[] = [];
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    $query: async (sql: string) => {
      queries.push(sql);
      return sql.includes('GROUP BY uid') ? summaryRows : [];
    },
  }),
}));
vi.mock('$lib/server/users.service', () => ({
  isInt4Id: (n: number) => Number.isInteger(n) && n > 0 && n <= 2147483647,
  usersByIds: async () => new Map(),
}));

const { getBuzzFlows, PLATFORM_SPEND_SHOWN } = await import('$lib/server/buzz-flows.service');

const summary = (over: Record<string, unknown>) => ({
  uid: '5',
  blueRewarded: '0',
  sent: [[], []],
  received: [[], []],
  trainings: '0',
  trainingsOnBlue: '0',
  spend: [[], [], []],
  refunds: [[], []],
  ...over,
});
const summarySql = () => queries.find((q) => q.includes('GROUP BY uid')) ?? '';

beforeEach(() => {
  summaryRows = [];
  queries.length = 0;
});

describe('buzz_flows platform spend', () => {
  it('reports generation paid from blue Buzz beside the blue Buzz rewarded', async () => {
    summaryRows = [
      summary({
        blueRewarded: '9000',
        spend: [
          ['generation:yellow', 'generation:blue'],
          ['192', '9857'],
          ['6', '443'],
        ],
      }),
    ];
    const { accounts } = await getBuzzFlows([5]);
    expect(accounts[0].blueRewarded).toBe(9000);
    expect(accounts[0].platformSpend).toEqual([
      { type: 'generation', accountType: 'blue', transactions: 443, amount: 9857 },
      { type: 'generation', accountType: 'yellow', transactions: 6, amount: 192 },
    ]);
    // Spend is what the account paid the platform (account 0), not what it sent to other accounts.
    expect(summarySql()).toContain(
      "sumMapIf([concat(type, ':', fromAccountType)], [toInt64(amount)], [toInt64(1)], dir = 'out' AND other = 0) AS spend"
    );
  });

  it('counts a platform refund as a refund, never as blue Buzz rewarded', async () => {
    summaryRows = [summary({ blueRewarded: '100', refunds: [['blue'], ['974']] })];
    const { accounts } = await getBuzzFlows([5]);
    expect(accounts[0].platformRefunds).toEqual({ blue: 974 });
    expect(accounts[0].blueRewarded).toBe(100);
    const sql = summarySql();
    expect(sql).toContain(
      "sumIf(amount, dir = 'in' AND type = 'reward' AND toAccountType = 'blue' AND other = 0) AS blueRewarded"
    );
    expect(sql).toContain(
      "sumMapIf([toAccountType], [toInt64(amount)], dir = 'in' AND other = 0 AND type IN ('refund', 'compensation')) AS refunds"
    );
  });

  it('withholds bank transactions from the spend summary unless asked to include them', async () => {
    await getBuzzFlows([5], 90, { includeBank: false });
    expect(summarySql().match(/type != 'bank'/g)).toHaveLength(2);
    queries.length = 0;
    await getBuzzFlows([5], 90, { includeBank: true });
    expect(summarySql()).not.toContain("'bank'");
  });

  it('keeps the largest kinds of spend and folds the rest into one row', async () => {
    const n = PLATFORM_SPEND_SHOWN + 3;
    const keys = Array.from({ length: n }, (_, i) => `t${i}:blue`);
    summaryRows = [
      summary({
        spend: [keys, keys.map((_, i) => String(i + 1)), keys.map(() => '1')],
      }),
    ];
    const spend = (await getBuzzFlows([5])).accounts[0].platformSpend;
    expect(spend).toHaveLength(PLATFORM_SPEND_SHOWN);
    expect(spend[0]).toEqual({
      type: `t${n - 1}`,
      accountType: 'blue',
      transactions: 1,
      amount: n,
    });
    // The 4 smallest (amounts 1..4) fold into one row; nothing is lost from the total.
    expect(spend.at(-1)).toEqual({
      type: 'other',
      accountType: 'mixed',
      transactions: 4,
      amount: 10,
    });
    expect(spend.reduce((s, r) => s + r.amount, 0)).toBe((n * (n + 1)) / 2);
  });
});
