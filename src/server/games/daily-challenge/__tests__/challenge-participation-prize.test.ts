import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as PrizeService from '~/server/services/prize.service';
import { dbMock } from '~/__tests__/mocks';

const { mockCreateBuzzTransactionMany, mockCreateNotification, mockCreatePrizes } = vi.hoisted(
  () => ({
    mockCreateBuzzTransactionMany: vi.fn(),
    mockCreateNotification: vi.fn(),
    mockCreatePrizes: vi.fn(),
  })
);

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/services/prize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PrizeService>()),
  createPrizes: mockCreatePrizes,
}));

const { distributeParticipationPrizes } = await import(
  '~/server/games/daily-challenge/challenge-rewards'
);

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: [] });
  mockCreateNotification.mockResolvedValue(undefined);
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ userId: 1 }, { userId: 2 }]);
});

// Product decision (2026-10-04): winner prizes are claimed; entry (participation) prizes are not — the daily
// job keeps paying them automatically, in blue. No Prize row, no claim.
describe('the daily job pays entry prizes automatically, in blue', () => {
  it('pays each earner directly and awards nothing to claim', async () => {
    const paid = await distributeParticipationPrizes({
      challengeId: 7,
      collectionId: 70,
      title: 'Neon Cats',
      entryPrize: { buzz: 50, points: 0 },
      entryPrizeRequirement: 1,
      excludeUserIds: [1],
      notificationKey: 'challenge-participation:7:final',
    });

    expect(paid).toEqual([2]);
    expect(mockCreateBuzzTransactionMany).toHaveBeenCalledWith([
      expect.objectContaining({
        toAccountId: 2,
        toAccountType: 'blue',
        amount: 50,
        externalTransactionId: 'challenge-entry-prize-7-2',
      }),
    ]);
    expect(mockCreatePrizes).not.toHaveBeenCalled();
  });
});
