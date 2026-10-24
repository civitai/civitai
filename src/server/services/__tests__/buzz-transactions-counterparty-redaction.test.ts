import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as UserService from '~/server/services/user.service';

const { mockQuery, mockGetUsers } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetUsers: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { $query: (sql: string) => mockQuery(sql) },
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUsers: (...args: unknown[]) => mockGetUsers(...args),
}));

import {
  buzzService,
  getUserBuzzTransactions,
  getUserBuzzTransactionsMulti,
  streamUserBuzzTransactionsCsv,
} from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
loggingMock.logToAxiom.mockResolvedValue(null);

const ACCOUNT_ID = 4242;
// Distinct from every other number in the fixtures, so a substring search for it is exact.
const TRIGGERING_USER_ID = 98765;
const REWARD_DETAILS = { type: 'goodContent:image', forId: 123, byUserId: TRIGGERING_USER_ID };
const REWARD_EXT_ID = `goodContent:image:123-${ACCOUNT_ID}-${TRIGGERING_USER_ID}`;
const PURCHASE_EXT_ID = 'pi_own_purchase_ref';

const WINDOW = {
  start: new Date('2026-09-20T00:00:00Z'),
  end: new Date('2026-09-26T23:59:59Z'),
  accountTypes: ['blue', 'green', 'yellow'] as const,
};

function clickhouseRows() {
  const base = {
    date: '2026-09-26 16:51:00',
    amount: 2,
    fromAccountId: 0,
    toAccountId: ACCOUNT_ID,
    fromAccountType: 'blue',
    toAccountType: 'blue',
    description: '',
  };
  return [
    {
      ...base,
      transactionId: '00000000-0000-0000-0000-000000000002',
      type: 'reward',
      details: JSON.stringify(REWARD_DETAILS),
      externalTransactionId: REWARD_EXT_ID,
    },
    {
      ...base,
      transactionId: '00000000-0000-0000-0000-000000000001',
      type: 'purchase',
      details: JSON.stringify({ entityType: 'Model', entityId: 5 }),
      externalTransactionId: PURCHASE_EXT_ID,
    },
  ];
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockQuery.mockReset();
  mockGetUsers.mockReset();
  mockGetUsers.mockResolvedValue([]);
  mockQuery.mockResolvedValue([]);
});

describe('buzz transaction views omit the user who triggered a reward', () => {
  it('getUserBuzzTransactionsMulti', async () => {
    mockQuery.mockResolvedValueOnce(clickhouseRows());

    const { transactions } = await getUserBuzzTransactionsMulti({
      accountId: ACCOUNT_ID,
      ...WINDOW,
    } as Parameters<typeof getUserBuzzTransactionsMulti>[0]);

    expect(transactions).toHaveLength(2);
    const [reward, purchase] = transactions;
    expect(reward.type).toBe(TransactionType.Reward);
    expect(reward.details).toEqual({ type: 'goodContent:image', forId: 123 });
    expect(reward.externalTransactionId).toBeNull();
    expect(JSON.stringify(transactions)).not.toContain(String(TRIGGERING_USER_ID));
    // The account's own processor reference is still shown.
    expect(purchase.type).toBe(TransactionType.Purchase);
    expect(purchase.externalTransactionId).toBe(PURCHASE_EXT_ID);
  });

  it('getUserBuzzTransactions', async () => {
    vi.spyOn(buzzService, 'getAccountTransactions').mockResolvedValue({
      cursor: null,
      transactions: [
        {
          date: '2026-09-26T16:51:00Z',
          type: 'Reward',
          fromAccountId: 0,
          toAccountId: ACCOUNT_ID,
          fromAccountType: 'blue',
          toAccountType: 'blue',
          amount: 2,
          description: 'Buzz Reward',
          details: REWARD_DETAILS,
          externalTransactionId: REWARD_EXT_ID,
        },
        {
          date: '2026-09-26T16:50:00Z',
          type: 'Purchase',
          fromAccountId: 0,
          toAccountId: ACCOUNT_ID,
          fromAccountType: 'yellow',
          toAccountType: 'yellow',
          amount: 1000,
          description: 'Purchase',
          details: {},
          externalTransactionId: PURCHASE_EXT_ID,
        },
      ],
    } as never);

    const { transactions } = await getUserBuzzTransactions({ accountId: ACCOUNT_ID } as Parameters<
      typeof getUserBuzzTransactions
    >[0]);

    expect(transactions).toHaveLength(2);
    const [reward, purchase] = transactions;
    expect(reward.type).toBe(TransactionType.Reward);
    expect(reward.details).toEqual({ type: 'goodContent:image', forId: 123 });
    expect(reward.externalTransactionId).toBeNull();
    expect(JSON.stringify(transactions)).not.toContain(String(TRIGGERING_USER_ID));
    expect(purchase.externalTransactionId).toBe(PURCHASE_EXT_ID);
  });

  it('streamUserBuzzTransactionsCsv', async () => {
    mockQuery.mockResolvedValueOnce(clickhouseRows());

    const chunks: string[] = [];
    for await (const chunk of streamUserBuzzTransactionsCsv({
      accountId: ACCOUNT_ID,
      ...WINDOW,
    } as Parameters<typeof streamUserBuzzTransactionsCsv>[0]))
      chunks.push(chunk);
    const lines = chunks.join('').trim().split('\r\n').filter(Boolean);

    expect(lines).toHaveLength(3);
    const extIdColumn = lines[0].split(',').indexOf('externalTransactionId');
    expect(extIdColumn).toBeGreaterThan(-1);
    const [reward, purchase] = lines.slice(1).map((line) => line.split(','));
    expect(reward[1]).toBe('Reward');
    expect(reward[extIdColumn]).toBe('');
    expect(purchase[1]).toBe('Purchase');
    expect(purchase[extIdColumn]).toBe(PURCHASE_EXT_ID);
    expect(lines.join('\n')).not.toContain(String(TRIGGERING_USER_ID));
  });
});
