import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import type { CosmeticShopItemHistoryEntry } from '~/server/schema/cosmetic-shop.schema';
import { CREATOR_SHOP_HISTORY_LIMIT, appendItemHistory } from '../creator-shop.data';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shopItemFindUnique: vi.fn(),
    shopItemUpdate: vi.fn(),
    userCosmeticCreateMany: vi.fn(),
    refreshOwnedStickerCache: vi.fn(),
    createNotification: vi.fn(),
    sharpMetadata: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmeticShopItem: { findUnique: mocks.shopItemFindUnique, findFirst: vi.fn() },
  },
  dbWrite: {
    cosmeticShopItem: { update: mocks.shopItemUpdate },
    cosmetic: { update: vi.fn() },
    userCosmetic: { createMany: mocks.userCosmeticCreateMany },
  },
}));
vi.mock('sharp', () => ({ default: () => ({ metadata: mocks.sharpMetadata }) }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  refreshOwnedStickerCache: mocks.refreshOwnedStickerCache,
}));

import { reviewCreatorShopItem, updateCreatorShopItem } from '../creator-shop.service';

// The item as it stands after the moderator asked for changes: approved once at
// 500 Buzz, currently sitting in RequestedChanges with the mod's note.
const requestedChangesItem = {
  id: 42,
  cosmeticId: 7,
  unitAmount: 500,
  status: 'RequestedChanges',
  title: 'Golden Laurel',
  description: 'A laurel',
  availableQuantity: null,
  addedById: 11,
  meta: {
    lastApprovedAmount: 500,
    history: [
      { at: '2026-08-01T00:00:00.000Z', userId: 11, kind: 'submitted', status: 'PendingReview' },
      {
        at: '2026-08-02T00:00:00.000Z',
        userId: 99,
        kind: 'reviewed',
        status: 'RequestedChanges',
        action: 'request-changes',
        note: 'Price is too high for a badge',
      },
    ],
  },
  cosmetic: {
    id: 7,
    createdById: 11,
    type: 'Badge',
    data: { url: 'old-art' },
    creator: { username: 'creator' },
  },
  _count: { purchases: 0 },
};

const historyOf = (call: number): CosmeticShopItemHistoryEntry[] =>
  mocks.shopItemUpdate.mock.calls[call][0].data.meta.history;

describe('appendItemHistory', () => {
  it('keeps the newest entries when the cap is hit', () => {
    const entry = (i: number) =>
      ({
        at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        userId: 1,
        kind: 'edited',
      } as const);
    const filled = Array.from({ length: CREATOR_SHOP_HISTORY_LIMIT }, (_, i) => entry(i));

    const { history } = appendItemHistory({ purchases: 0, history: filled }, entry(99));

    expect(history).toHaveLength(CREATOR_SHOP_HISTORY_LIMIT);
    expect(history?.[CREATOR_SHOP_HISTORY_LIMIT - 1]).toEqual(entry(99));
    expect(history?.[0]).toEqual(entry(1));
  });
});

describe('creator shop item history', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindUnique.mockResolvedValue(requestedChangesItem);
    mocks.shopItemUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 42,
      ...data,
    }));
    mocks.sharpMetadata.mockResolvedValue({
      width: 144,
      height: 144,
      format: 'png',
      hasAlpha: true,
      pages: 1,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
    );
  });

  it('records an edit, its re-review, and the approval as three ordered entries', async () => {
    await updateCreatorShopItem({ id: 42, userId: 11, price: 900 });

    const afterEdit = historyOf(0);
    expect(afterEdit).toHaveLength(3);
    const edit = afterEdit[2];
    expect(edit).toMatchObject({
      userId: 11,
      kind: 'edited',
      status: 'PendingReview',
      changes: [{ field: 'price', from: 500, to: 900 }],
    });
    // The edit is what pushed it back into the queue; a re-reviewer needs to
    // see that, not just the new price.
    expect(edit.note).toMatch(/Resubmitted for review/);
    // The previous verdict survives the edit that clears `rejectionReason`.
    expect(afterEdit[1].note).toBe('Price is too high for a badge');

    // The approval builds on the item as the edit left it.
    mocks.shopItemFindUnique.mockResolvedValue({
      ...requestedChangesItem,
      status: 'PendingReview',
      unitAmount: 900,
      meta: { ...requestedChangesItem.meta, history: afterEdit },
    });
    await reviewCreatorShopItem({ id: 42, reviewerId: 99, action: 'approve' });

    const afterApproval = historyOf(1);
    expect(afterApproval).toHaveLength(4);
    expect(afterApproval[3]).toMatchObject({
      userId: 99,
      kind: 'reviewed',
      action: 'approve',
      status: 'Published',
    });
    expect(afterApproval.map((e) => e.kind)).toEqual([
      'submitted',
      'reviewed',
      'edited',
      'reviewed',
    ]);
  });

  it('records the pre-swap artwork url so a swap is identifiable', async () => {
    await updateCreatorShopItem({
      id: 42,
      userId: 11,
      // A moderator swap doesn't re-affirm the rights, so the edit doesn't need
      // a `rightsAffirmed` flag it would otherwise be rejected without.
      isModerator: true,
      imageUrl: 'new-art',
    });

    expect(historyOf(0)[2].changes).toContainEqual({
      field: 'artwork',
      from: 'old-art',
      to: 'new-art',
    });
  });

  it('leaves history untouched when an edit moves nothing', async () => {
    await updateCreatorShopItem({ id: 42, userId: 11, price: 500 });

    expect(historyOf(0)).toEqual(requestedChangesItem.meta.history);
  });

  it('records a rejection with its note and reviewer', async () => {
    await reviewCreatorShopItem({
      id: 42,
      reviewerId: 99,
      action: 'reject',
      rejectionReason: 'Traced artwork',
    });

    const history = historyOf(0);
    expect(history[history.length - 1]).toMatchObject({
      userId: 99,
      kind: 'reviewed',
      action: 'reject',
      status: 'Rejected',
      note: 'Traced artwork',
    });
  });
});
