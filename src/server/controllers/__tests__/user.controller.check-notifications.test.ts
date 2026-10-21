import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationService from '~/server/services/notification.service';
import type * as PlacementService from '~/server/services/placement.service';
import type * as CollectionService from '~/server/services/collection.service';
import type * as MysteryBoxInventoryService from '~/server/services/mystery-box-inventory.service';
import type * as PrizeService from '~/server/services/prize.service';

const { countBoxes, countPrizes } = vi.hoisted(() => ({
  countBoxes: vi.fn(),
  countPrizes: vi.fn(),
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  getUserNotificationCount: vi.fn(async () => [{ category: 'Comment', count: 2 }]),
}));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  getPendingPlacementCounts: vi.fn(async () => ({ sticker: 1, remix: 0 })),
}));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getPendingCollectionReviewCounts: vi.fn(async () => ({ total: 0, byCollection: {} })),
}));
vi.mock('~/server/services/mystery-box-inventory.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MysteryBoxInventoryService>()),
  countHeldMysteryBoxes: countBoxes,
}));
vi.mock('~/server/services/prize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PrizeService>()),
  countUnclaimedPrizes: countPrizes,
}));

const { checkUserNotificationsHandler } = await import('~/server/controllers/user.controller');

const check = ({
  mysteryBox = true,
  userMenuV2 = false,
  isModerator = false,
  country,
}: Partial<{
  mysteryBox: boolean;
  userMenuV2: boolean;
  isModerator: boolean;
  country: string;
}> = {}) =>
  checkUserNotificationsHandler({
    ctx: {
      user: { id: 7, isModerator },
      features: { mysteryBox, userMenuV2 },
      req: { headers: country ? { 'cf-ipcountry': country } : {} },
    } as never,
  });

beforeEach(() => {
  countBoxes.mockReset();
  countPrizes.mockReset();
});

describe('checkNotifications', () => {
  it('carries the unopened box count, read for this viewer, flag and country', async () => {
    countBoxes.mockResolvedValue(3);

    const counts = await check({ isModerator: true, country: 'BE' });

    expect(counts.unopenedBoxes).toBe(3);
    expect(counts.comment).toBe(2);
    expect(countBoxes).toHaveBeenCalledWith({
      userId: 7,
      isModerator: true,
      mysteryBoxEnabled: true,
      countryCode: 'BE',
    });
  });

  it('passes the flag off through, for the read to hide boxes', async () => {
    countBoxes.mockResolvedValue(0);

    await check({ mysteryBox: false });

    expect(countBoxes).toHaveBeenCalledWith(expect.objectContaining({ mysteryBoxEnabled: false }));
  });

  it('answers 0 boxes, and every other count, when the box count fails', async () => {
    countBoxes.mockRejectedValue(new Error('replica down'));

    const counts = await check();

    expect(counts.unopenedBoxes).toBe(0);
    expect(counts.comment).toBe(2);
    expect(counts.pendingPlacements).toBe(1);
  });

  it('carries the unclaimed prize count for this viewer when the new user menu is on', async () => {
    countBoxes.mockResolvedValue(0);
    countPrizes.mockResolvedValue(2);

    const counts = await check({ userMenuV2: true });

    expect(counts.unclaimedPrizes).toBe(2);
    expect(countPrizes).toHaveBeenCalledWith(7);
  });

  it('does not count prizes while the new user menu is off', async () => {
    countBoxes.mockResolvedValue(0);
    countPrizes.mockResolvedValue(2);

    const counts = await check({ userMenuV2: false });

    expect(counts.unclaimedPrizes).toBe(0);
    expect(countPrizes).not.toHaveBeenCalled();
  });

  it('answers 0 prizes, and every other count, when the prize count fails', async () => {
    countBoxes.mockResolvedValue(1);
    countPrizes.mockRejectedValue(new Error('replica down'));

    const counts = await check({ userMenuV2: true });

    expect(counts.unclaimedPrizes).toBe(0);
    expect(counts.unopenedBoxes).toBe(1);
    expect(counts.comment).toBe(2);
  });
});
