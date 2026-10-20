import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingSteps } from '~/server/common/enums';
import { decidePayoutReview, getSettlementHolds, PayoutReviewError } from '../hold';

const reviews = dbMock.dbWrite.creatorProgramPayoutReview;

const review = (over: Record<string, unknown> = {}) => ({
  id: 41,
  userId: 9,
  period: '2026-10',
  status: 'open',
  askRef: null,
  ...over,
});

const decide = (action: 'escalate' | 'clear' | 'withhold') =>
  decidePayoutReview({ id: 41, action, decidedBy: 'ag_test', askRef: 'card-1' });

beforeEach(() => {
  vi.clearAllMocks();
  reviews.updateMany.mockResolvedValue({ count: 1 });
});

describe('getSettlementHolds', () => {
  it('holds open, escalated and withheld creators, and adds cleared ones who are not banned', async () => {
    reviews.findMany.mockResolvedValue([
      { userId: 1, status: 'open', hold: true },
      { userId: 2, status: 'escalated', hold: true },
      { userId: 3, status: 'withheld', hold: true },
      { userId: 4, status: 'cleared', hold: false },
      { userId: 5, status: 'cleared', hold: false },
      { userId: 6, status: 'cleared', hold: false },
      // Cleared for one period, still held for another: held wins.
      { userId: 1, status: 'cleared', hold: false },
    ]);
    dbMock.dbWrite.user.findMany.mockResolvedValue([
      { id: 4, onboarding: 0 },
      { id: 5, onboarding: OnboardingSteps.BannedCreatorProgram },
    ]);

    const holds = await getSettlementHolds('2026-10');

    expect(holds.heldUserIds).toEqual(new Set([1, 2, 3]));
    expect(holds.clearedUserIds).toEqual([4]);
    expect(dbMock.dbWrite.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [4, 5, 6] }, bannedAt: null } })
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
