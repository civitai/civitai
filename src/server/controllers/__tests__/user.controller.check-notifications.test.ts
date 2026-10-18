import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationService from '~/server/services/notification.service';
import type * as PlacementService from '~/server/services/placement.service';
import type * as CollectionService from '~/server/services/collection.service';
import type * as MysteryBoxInventoryService from '~/server/services/mystery-box-inventory.service';

// The once-a-session notification counts also carry the user menu's unopened box count. It gets
// the same flag, country and viewer as the Inventory's own read, and a failure there must not take
// the notification bell down with it.

const { countBoxes } = vi.hoisted(() => ({ countBoxes: vi.fn() }));

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

const { checkUserNotificationsHandler } = await import('~/server/controllers/user.controller');

const check = ({
  mysteryBox = true,
  isModerator = false,
  country,
}: Partial<{
  mysteryBox: boolean;
  isModerator: boolean;
  country: string;
}> = {}) =>
  checkUserNotificationsHandler({
    ctx: {
      user: { id: 7, isModerator },
      features: { mysteryBox },
      req: { headers: country ? { 'cf-ipcountry': country } : {} },
    } as never,
  });

beforeEach(() => {
  countBoxes.mockReset();
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
});
