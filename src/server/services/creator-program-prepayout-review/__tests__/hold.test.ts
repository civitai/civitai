import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as CreatorProgramService from '~/server/services/creator-program.service';
import type * as NotificationService from '~/server/services/notification.service';

const mocks = vi.hoisted(() => ({
  createBuzzTransactionMany: vi.fn(),
  getAccountsBalances: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransactionMany: mocks.createBuzzTransactionMany,
  getAccountsBalances: mocks.getAccountsBalances,
}));
vi.mock('~/server/services/creator-program.service', async (importOriginal) => {
  const original = await importOriginal<typeof CreatorProgramService>();
  return { ...original, userCashCache: { ...original.userCashCache, bust: vi.fn() } };
});
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));
vi.mock('~/utils/signal-client', () => ({ signalClient: { topicSend: vi.fn() } }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { decidePayoutReview, getSettlementHolds, PayoutReviewError } from '../hold';

const review = (over: Record<string, unknown> = {}) => ({
  id: 41,
  userId: 9,
  period: '2026-10',
  status: 'open',
  askRef: null,
  releasedAt: null,
  ...over,
});

const decide = (action: 'escalate' | 'clear' | 'withhold' | 'release') =>
  decidePayoutReview({ id: 41, action, decidedBy: 'ag_test', askRef: 'card-1' });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.creatorProgramPayoutReview.updateMany.mockResolvedValue({ count: 1 });
  mocks.getAccountsBalances.mockResolvedValue([{ accountId: 9, balance: 4_200 }]);
});

describe('getSettlementHolds', () => {
  it('keeps a withheld creator held, not only open and escalated ones', async () => {
    dbMock.dbWrite.creatorProgramPayoutReview.findMany.mockResolvedValue([{ userId: 9 }]);

    expect((await getSettlementHolds('2026-10')).heldUserIds).toEqual(new Set([9]));
    expect(dbMock.dbWrite.creatorProgramPayoutReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { hold: true, status: { in: ['open', 'escalated', 'withheld'] } },
      })
    );
  });
});

describe('decidePayoutReview', () => {
  it('clearing lifts the hold, conditional on the status it read', async () => {
    dbMock.dbWrite.creatorProgramPayoutReview.findUnique.mockResolvedValue(review());

    expect(await decide('clear')).toEqual({ id: 41, status: 'cleared' });
    expect(dbMock.dbWrite.creatorProgramPayoutReview.updateMany).toHaveBeenCalledWith({
      where: { id: 41, status: 'open' },
      data: expect.objectContaining({ status: 'cleared', hold: false, decidedBy: 'ag_test' }),
    });
  });

  it.each(['escalate', 'withhold'] as const)('%s keeps the hold', async (action) => {
    dbMock.dbWrite.creatorProgramPayoutReview.findUnique.mockResolvedValue(review());

    await decide(action);
    expect(dbMock.dbWrite.creatorProgramPayoutReview.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hold: true }) })
    );
  });

  it('refuses to clear a withheld payout', async () => {
    dbMock.dbWrite.creatorProgramPayoutReview.findUnique.mockResolvedValue(
      review({ status: 'withheld' })
    );

    await expect(decide('clear')).rejects.toMatchObject({ status: 409 });
    expect(dbMock.dbWrite.creatorProgramPayoutReview.updateMany).not.toHaveBeenCalled();
  });

  it('reports a lost race instead of claiming the decision applied', async () => {
    dbMock.dbWrite.creatorProgramPayoutReview.findUnique.mockResolvedValue(review());
    dbMock.dbWrite.creatorProgramPayoutReview.updateMany.mockResolvedValue({ count: 0 });

    await expect(decide('clear')).rejects.toBeInstanceOf(PayoutReviewError);
  });
});

describe('release', () => {
  it('settles the current pending balance under ids the monthly settlement never uses', async () => {
    dbMock.dbWrite.creatorProgramPayoutReview.findUnique.mockResolvedValue(
      review({ status: 'cleared' })
    );

    expect(await decide('release')).toMatchObject({ released: 4_200 });

    const [txs] = mocks.createBuzzTransactionMany.mock.calls[0] as [
      {
        fromAccountType: string;
        toAccountId: number;
        amount: number;
        externalTransactionId: string;
      }[]
    ];
    expect(txs.map((t) => [t.fromAccountType, t.toAccountId, t.amount])).toEqual([
      ['cashPending', 0, 4_200],
      ['cashSettled', 9, 4_200],
    ]);
    for (const t of txs) expect(t.externalTransactionId).not.toMatch(/^settlement-(bank-)?v2-/);
    expect(new Set(txs.map((t) => t.externalTransactionId)).size).toBe(2);
    expect(dbMock.dbWrite.creatorProgramPayoutReview.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: { releasedAt: expect.any(Date), releaseExternalId: 'settlement-release-41' },
    });
  });

  it.each([
    ['an uncleared review', review({ status: 'open' })],
    ['a review already released', review({ status: 'cleared', releasedAt: new Date() })],
  ])('refuses %s', async (_, row) => {
    dbMock.dbWrite.creatorProgramPayoutReview.findUnique.mockResolvedValue(row);

    await expect(decide('release')).rejects.toMatchObject({ status: 409 });
    expect(mocks.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('moves nothing when nothing is pending', async () => {
    dbMock.dbWrite.creatorProgramPayoutReview.findUnique.mockResolvedValue(
      review({ status: 'cleared' })
    );
    mocks.getAccountsBalances.mockResolvedValue([{ accountId: 9, balance: 0 }]);

    expect(await decide('release')).toMatchObject({ released: 0 });
    expect(mocks.createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});
