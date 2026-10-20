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
import { OnboardingSteps } from '~/server/common/enums';
import {
  decidePayoutReview,
  getSettlementHolds,
  inSettlementWindow,
  PayoutReviewError,
} from '../hold';

const reviews = dbMock.dbWrite.creatorProgramPayoutReview;
const MID_MONTH = new Date('2026-11-20T12:00:00Z');

const review = (over: Record<string, unknown> = {}) => ({
  id: 41,
  userId: 9,
  period: '2026-10',
  status: 'open',
  payoutCents: 5_000,
  askRef: null,
  releasedAt: null,
  ...over,
});

const decide = (action: 'escalate' | 'clear' | 'withhold' | 'release', now: Date = MID_MONTH) =>
  decidePayoutReview({ id: 41, action, decidedBy: 'ag_test', askRef: 'card-1' }, now);

beforeEach(() => {
  vi.clearAllMocks();
  reviews.updateMany.mockResolvedValue({ count: 1 });
  reviews.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ bannedAt: null, onboarding: 0 });
  mocks.getAccountsBalances.mockResolvedValue([{ accountId: 9, balance: 4_200 }]);
  mocks.createBuzzTransactionMany.mockResolvedValue(undefined);
});

describe('getSettlementHolds', () => {
  it('keeps a withheld creator held, not only open and escalated ones', async () => {
    reviews.findMany.mockResolvedValue([{ userId: 9 }]);

    expect((await getSettlementHolds('2026-10')).heldUserIds).toEqual(new Set([9]));
    expect(reviews.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { hold: true, status: { in: ['open', 'escalated', 'withheld'] } },
      })
    );
  });
});

describe('decidePayoutReview', () => {
  it('clearing lifts the hold, conditional on the status it read', async () => {
    reviews.findUnique.mockResolvedValue(review());

    expect(await decide('clear')).toEqual({ id: 41, status: 'cleared' });
    expect(reviews.updateMany).toHaveBeenCalledWith({
      where: { id: 41, status: 'open' },
      data: expect.objectContaining({ status: 'cleared', hold: false, decidedBy: 'ag_test' }),
    });
  });

  it('a withhold made in error can be cleared', async () => {
    reviews.findUnique.mockResolvedValue(review({ status: 'withheld' }));

    expect(await decide('clear')).toEqual({ id: 41, status: 'cleared' });
  });

  it.each(['escalate', 'withhold'] as const)('%s keeps the hold', async (action) => {
    reviews.findUnique.mockResolvedValue(review());

    await decide(action);
    expect(reviews.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hold: true }) })
    );
  });

  it.each([
    ['withhold', 'cleared'],
    ['escalate', 'withheld'],
  ] as const)('refuses to %s a %s review', async (action, status) => {
    reviews.findUnique.mockResolvedValue(review({ status }));

    await expect(decide(action)).rejects.toMatchObject({ status: 409 });
    expect(reviews.updateMany).not.toHaveBeenCalled();
  });

  it('reports a lost race instead of claiming the decision applied', async () => {
    reviews.findUnique.mockResolvedValue(review());
    reviews.updateMany.mockResolvedValue({ count: 0 });

    await expect(decide('clear')).rejects.toBeInstanceOf(PayoutReviewError);
  });
});

describe('release', () => {
  beforeEach(() => {
    reviews.findUnique.mockResolvedValue(review({ status: 'cleared' }));
  });

  it("settles the creator's pending cash under ids the monthly settlement never uses", async () => {
    expect(await decide('release')).toMatchObject({ released: 4_200 });

    expect(mocks.getAccountsBalances).toHaveBeenCalledWith({
      accountIds: [9],
      accountTypes: ['cashPending'],
    });
    expect(reviews.updateMany).toHaveBeenCalledWith({
      where: { id: 41, releasedAt: null },
      data: { releasedAt: MID_MONTH, releaseExternalId: 'settlement-release-41' },
    });
    expect(mocks.createBuzzTransactionMany).toHaveBeenCalledWith([
      expect.objectContaining({
        fromAccountType: 'cashPending',
        fromAccountId: 9,
        toAccountType: 'cashSettled',
        toAccountId: 0,
        amount: 4_200,
        externalTransactionId: 'settlement-release-bank-41',
      }),
      expect.objectContaining({
        fromAccountType: 'cashSettled',
        fromAccountId: 0,
        toAccountType: 'cashSettled',
        toAccountId: 9,
        amount: 4_200,
        externalTransactionId: 'settlement-release-41',
      }),
    ]);
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'creator-program-funds-settled', userIds: [9] })
    );
  });

  it('pays no more than the reviewed payout, leaving later unreviewed credit pending', async () => {
    reviews.findUnique.mockResolvedValue(review({ status: 'cleared', payoutCents: 3_000 }));

    expect(await decide('release')).toMatchObject({ released: 3_000 });
    const [txs] = mocks.createBuzzTransactionMany.mock.calls[0] as [{ amount: number }[]];
    expect(txs.map((t) => t.amount)).toEqual([3_000, 3_000]);
  });

  it.each([
    ['an open review', () => reviews.findUnique.mockResolvedValue(review())],
    [
      'a withheld review',
      () => reviews.findUnique.mockResolvedValue(review({ status: 'withheld' })),
    ],
    [
      'a review already released',
      () =>
        reviews.findUnique.mockResolvedValue(review({ status: 'cleared', releasedAt: new Date() })),
    ],
    ['a creator another review still holds', () => reviews.findFirst.mockResolvedValue({ id: 7 })],
    [
      'a banned creator',
      () =>
        dbMock.dbWrite.user.findUnique.mockResolvedValue({ bannedAt: new Date(), onboarding: 0 }),
    ],
    [
      'a creator removed from the Program',
      () =>
        dbMock.dbWrite.user.findUnique.mockResolvedValue({
          bannedAt: null,
          onboarding: OnboardingSteps.BannedCreatorProgram,
        }),
    ],
    [
      'a release that lost the claim race',
      () => reviews.updateMany.mockResolvedValue({ count: 0 }),
    ],
  ])('refuses %s', async (_, arrange) => {
    arrange();

    await expect(decide('release')).rejects.toMatchObject({ status: 409 });
    expect(mocks.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('looks for other holds on the same creator', async () => {
    await decide('release');

    expect(reviews.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 9, hold: true, status: { in: ['open', 'escalated', 'withheld'] } },
      })
    );
  });

  it.each([
    ['2026-11-15T00:00:30Z', true],
    ['2026-11-15T23:59:00Z', true],
    ['2026-11-14T23:10:00Z', true],
    ['2026-11-14T22:59:00Z', false],
    ['2026-11-16T00:00:00Z', false],
  ])('settlement window at %s: %s', (at, expected) => {
    expect(inSettlementWindow(new Date(at))).toBe(expected);
  });

  it('refuses during the settlement window', async () => {
    await expect(decide('release', new Date('2026-11-15T00:00:30Z'))).rejects.toMatchObject({
      status: 409,
    });
    expect(mocks.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('gives the claim back when the ledger write fails, so a retry can release', async () => {
    mocks.createBuzzTransactionMany.mockRejectedValue(new Error('buzz down'));

    await expect(decide('release')).rejects.toThrow('buzz down');
    expect(reviews.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: { releasedAt: null, releaseExternalId: null },
    });
  });

  it('moves nothing when nothing is pending', async () => {
    mocks.getAccountsBalances.mockResolvedValue([{ accountId: 9, balance: 0 }]);

    expect(await decide('release')).toMatchObject({ released: 0 });
    expect(mocks.createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});
