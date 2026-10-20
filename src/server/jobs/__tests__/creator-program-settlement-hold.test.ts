import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as CreatorProgramService from '~/server/services/creator-program.service';
import type * as NotificationService from '~/server/services/notification.service';

const mocks = vi.hoisted(() => ({
  createBuzzTransactionMany: vi.fn(),
  getAccountsBalances: vi.fn(),
  getPoolParticipantsV2: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { $query: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransactionMany: mocks.createBuzzTransactionMany,
  getAccountsBalances: mocks.getAccountsBalances,
}));
vi.mock('~/server/services/creator-program.service', async (importOriginal) => {
  const original = await importOriginal<typeof CreatorProgramService>();
  return {
    ...original,
    getPoolParticipantsV2: mocks.getPoolParticipantsV2,
    userCashCache: { ...original.userCashCache, bust: vi.fn() },
  };
});
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));
vi.mock('~/utils/signal-client', () => ({ signalClient: { topicSend: vi.fn() } }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { creatorsProgramSettleCash } from '~/server/jobs/creators-program-jobs';

const ledgerRows = () =>
  mocks.createBuzzTransactionMany.mock.calls.flatMap(
    ([txs]) =>
      txs as {
        fromAccountId: number;
        toAccountId: number;
        amount: number;
        externalTransactionId: string;
        description: string;
      }[]
  );

const settledUserIds = () =>
  mocks.createBuzzTransactionMany.mock.calls
    .flatMap(([txs]) => txs as { toAccountId: number; toAccountType: string }[])
    .filter((t) => t.toAccountId !== 0)
    .map((t) => t.toAccountId);

const missingAlerts = () =>
  loggingMock.logToAxiom.mock.calls.filter(
    ([entry]) => (entry as { name?: string }).name === 'creator-program-prepayout-review-missing'
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T00:00:05Z'));
  mocks.getPoolParticipantsV2.mockResolvedValue([
    { userId: 1, amount: 100 },
    { userId: 2, amount: 100 },
    { userId: 3, amount: 100 },
  ]);
  mocks.getAccountsBalances.mockResolvedValue([
    { accountId: 1, balance: 1_000 },
    { accountId: 2, balance: 2_000 },
    { accountId: 3, balance: 3_000 },
  ]);
  mocks.createBuzzTransactionMany.mockResolvedValue(undefined);
  dbMock.dbWrite.creatorProgramPayoutReview.findMany.mockResolvedValue([
    { userId: 2, status: 'open', hold: true },
  ]);
  dbMock.dbWrite.creatorProgramPayoutReviewRun.findFirst.mockResolvedValue({ id: 1 });
});

describe('creators-program-settlement with held payouts', () => {
  it('settles everyone except a held creator, whose cash stays pending', async () => {
    await creatorsProgramSettleCash.run({}).result;

    expect(settledUserIds()).toEqual([1, 3]);
    // Keys use the settlement month (November), not the reviewed period (October): a key
    // shared with an earlier settlement would be a different payment deduplicated away.
    expect(
      ledgerRows().map((t) => [
        t.fromAccountId,
        t.toAccountId,
        t.amount,
        t.externalTransactionId,
        t.description,
      ])
    ).toEqual([
      [1, 0, 1_000, 'settlement-bank-v2-2026-11-1', 'Move from pending 2026-11'],
      [0, 1, 1_000, 'settlement-v2-2026-11-1', 'Cash settlement for 2026-11'],
      [3, 0, 3_000, 'settlement-bank-v2-2026-11-3', 'Move from pending 2026-11'],
      [0, 3, 3_000, 'settlement-v2-2026-11-3', 'Cash settlement for 2026-11'],
    ]);
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: [1, 3] })
    );
  });

  it('writes nothing when every creator is held', async () => {
    dbMock.dbWrite.creatorProgramPayoutReview.findMany.mockResolvedValue(
      [1, 2, 3].map((userId) => ({ userId, status: 'open', hold: true }))
    );

    await creatorsProgramSettleCash.run({}).result;

    expect(mocks.createBuzzTransactionMany).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('pays a cleared creator who did not bank last month, once cleared', async () => {
    dbMock.dbWrite.creatorProgramPayoutReview.findMany.mockResolvedValue([
      { userId: 2, status: 'open', hold: true },
      { userId: 7, status: 'cleared', hold: false },
    ]);
    dbMock.dbWrite.user.findMany.mockResolvedValue([{ id: 7, onboarding: 0 }]);
    mocks.getAccountsBalances.mockImplementation(async ({ accountIds }: { accountIds: number[] }) =>
      accountIds.map((accountId) => ({ accountId, balance: accountId * 1_000 }))
    );

    await creatorsProgramSettleCash.run({}).result;

    expect(mocks.getAccountsBalances).toHaveBeenCalledWith({
      accountIds: [1, 2, 3, 7],
      accountTypes: ['cashPending'],
    });
    expect(settledUserIds()).toEqual([1, 3, 7]);
  });

  it('leaves withheld cash pending into the next cycle, untouched, until re-decided', async () => {
    // October was withheld and November has no decision yet: the December 15th run.
    vi.setSystemTime(new Date('2026-12-15T00:00:05Z'));
    dbMock.dbWrite.creatorProgramPayoutReview.findMany.mockResolvedValue([
      { userId: 2, status: 'withheld', hold: true, period: '2026-10' },
    ]);

    await creatorsProgramSettleCash.run({}).result;

    expect(settledUserIds()).toEqual([1, 3]);
    // No ledger row moves or zeroes the withheld creator's pending cash.
    expect(ledgerRows().some((t) => t.fromAccountId === 2 || t.toAccountId === 2)).toBe(false);
  });

  it('skips a creator with nothing pending', async () => {
    dbMock.dbWrite.creatorProgramPayoutReview.findMany.mockResolvedValue([]);
    mocks.getAccountsBalances.mockResolvedValue([
      { accountId: 1, balance: 1_000 },
      { accountId: 2, balance: 0 },
      { accountId: 3, balance: -5 },
    ]);

    await creatorsProgramSettleCash.run({}).result;

    expect(settledUserIds()).toEqual([1]);
  });

  it('settles everyone when nobody is held', async () => {
    dbMock.dbWrite.creatorProgramPayoutReview.findMany.mockResolvedValue([]);

    await creatorsProgramSettleCash.run({}).result;

    expect(settledUserIds()).toEqual([1, 2, 3]);
  });

  it('reads the holds for last month and checks that its review finished', async () => {
    await creatorsProgramSettleCash.run({}).result;

    expect(dbMock.dbWrite.creatorProgramPayoutReviewRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { period: '2026-10', finishedAt: { not: null }, error: null },
      })
    );
    expect(missingAlerts()).toEqual([]);
  });

  it('still pays the unheld when the review never finished, and alerts', async () => {
    dbMock.dbWrite.creatorProgramPayoutReviewRun.findFirst.mockResolvedValue(null);

    await creatorsProgramSettleCash.run({}).result;

    expect(settledUserIds()).toEqual([1, 3]);
    expect(missingAlerts()).toHaveLength(1);
  });

  it.each([
    ['the review tables are empty', null],
    [
      'the review tables do not exist yet',
      new Prisma.PrismaClientKnownRequestError('missing table', {
        code: 'P2021',
        clientVersion: 'test',
      }),
    ],
  ])('holds nobody and alerts when %s', async (_, error) => {
    if (error) {
      dbMock.dbWrite.creatorProgramPayoutReview.findMany.mockRejectedValue(error);
      dbMock.dbWrite.creatorProgramPayoutReviewRun.findFirst.mockRejectedValue(error);
    } else {
      dbMock.dbWrite.creatorProgramPayoutReview.findMany.mockResolvedValue([]);
      dbMock.dbWrite.creatorProgramPayoutReviewRun.findFirst.mockResolvedValue(null);
    }

    await creatorsProgramSettleCash.run({}).result;

    expect(settledUserIds()).toEqual([1, 2, 3]);
    expect(missingAlerts()).toHaveLength(1);
  });

  it.each([
    ['an outage', new Error('db down')],
    [
      'a pool timeout',
      new Prisma.PrismaClientKnownRequestError('db down', { code: 'P2024', clientVersion: 'test' }),
    ],
  ])('pays nobody when the holds cannot be read because of %s', async (_, error) => {
    dbMock.dbWrite.creatorProgramPayoutReview.findMany.mockRejectedValue(error);

    await expect(creatorsProgramSettleCash.run({}).result).rejects.toThrow('db down');
    expect(mocks.createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});
