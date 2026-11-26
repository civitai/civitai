import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type * as ClickhouseClient from '~/server/clickhouse/client';

/**
 * The membership history page lists past prepaid deliveries. Its legacy part comes from a slow
 * query over a closed date window, so a user's legacy rows are fetched once and kept; the recent
 * membership deliveries are still re-read once the page's own hour-long cache expires.
 */

type LegacyRow = {
  date: string;
  type: string;
  amount: number;
  externalTransactionId: string;
  description: string;
};
type MembershipRow = {
  date: string;
  amount: number;
  externalTransactionId: string;
  details: string;
};
// What ClickHouse holds, per user.
const legacy = new Map<number, LegacyRow[]>();
const membership = new Map<number, MembershipRow[]>();
// Which user each query was sent for, by table.
const queries: { table: 'legacy' | 'membership'; userId: number }[] = [];

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: {
    // Both queries interpolate the user id as `toAccountId = ${userId}`.
    $query: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      const userId = values.find((v): v is number => typeof v === 'number') as number;
      if (sql.includes('FROM buzzTransactions')) {
        queries.push({ table: 'legacy', userId });
        return legacy.get(userId) ?? [];
      }
      if (sql.includes('FROM membership_prepaid_deliveries')) {
        queries.push({ table: 'membership', userId });
        return membership.get(userId) ?? [];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  },
}));

const { getHistoricalPrepaidDeliveries } = await import('~/server/services/subscriptions.service');

const ANNUAL_MEMBER = 5_521;
const NO_LEGACY = 5_534;
const OTHER_NO_LEGACY = 5_547;
const T0 = new Date('2026-11-20T12:00:00Z').getTime();
const HOUR = 60 * 60_000;
const count = (table: 'legacy' | 'membership', userId: number) =>
  queries.filter((q) => q.table === table && q.userId === userId).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  installFakeCacheRedis();
  legacy.clear();
  membership.clear();
  queries.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('getHistoricalPrepaidDeliveries: legacy rows', () => {
  it('queries the legacy window once per user, while new membership deliveries still appear', async () => {
    legacy.set(ANNUAL_MEMBER, [
      {
        date: '2025-06-15 10:00:00',
        type: 'purchase',
        amount: 15000,
        externalTransactionId: `annual-sub-payment-2025-06:${ANNUAL_MEMBER}:pro_01j6d72j9eaf5sqsvha0xbafgv`,
        description: '',
      },
    ]);
    const annualToken = {
      id: `history_annual-sub-payment-2025-06:${ANNUAL_MEMBER}:pro_01j6d72j9eaf5sqsvha0xbafgv`,
      tier: 'silver',
      status: 'claimed',
      buzzAmount: 15000,
      claimedAt: '2025-06-15T10:00:00.000Z',
      buzzTransactionId: `annual-sub-payment-2025-06:${ANNUAL_MEMBER}:pro_01j6d72j9eaf5sqsvha0xbafgv`,
      description: 'Annual · Jun 2025',
    };

    expect(await getHistoricalPrepaidDeliveries({ userId: ANNUAL_MEMBER })).toEqual([annualToken]);

    // A month's delivery lands, and the page's hour-long cache runs out.
    membership.set(ANNUAL_MEMBER, [
      {
        date: '2026-11-20 13:30:00',
        amount: 25000,
        externalTransactionId: `civitai-membership:2026-11:${ANNUAL_MEMBER}:gold`,
        details: '{"tier":"gold"}',
      },
    ]);
    vi.setSystemTime(T0 + 2 * HOUR);

    expect(await getHistoricalPrepaidDeliveries({ userId: ANNUAL_MEMBER })).toEqual([
      {
        id: `history_civitai-membership:2026-11:${ANNUAL_MEMBER}:gold`,
        tier: 'gold',
        status: 'claimed',
        buzzAmount: 25000,
        claimedAt: '2026-11-20T13:30:00.000Z',
        buzzTransactionId: `civitai-membership:2026-11:${ANNUAL_MEMBER}:gold`,
        description: 'Membership · Nov 2026',
      },
      annualToken,
    ]);
    expect(count('membership', ANNUAL_MEMBER)).toBe(2);
    expect(count('legacy', ANNUAL_MEMBER)).toBe(1);
  });

  it('keeps an empty legacy answer too, per user', async () => {
    expect(await getHistoricalPrepaidDeliveries({ userId: NO_LEGACY })).toEqual([]);
    vi.setSystemTime(T0 + 2 * HOUR);
    expect(await getHistoricalPrepaidDeliveries({ userId: NO_LEGACY })).toEqual([]);
    expect(await getHistoricalPrepaidDeliveries({ userId: OTHER_NO_LEGACY })).toEqual([]);

    expect(count('legacy', NO_LEGACY)).toBe(1);
    expect(count('legacy', OTHER_NO_LEGACY)).toBe(1);
  });
});
