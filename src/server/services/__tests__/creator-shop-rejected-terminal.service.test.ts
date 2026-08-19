/**
 * A rejection is terminal on every path a creator can reach: they can't edit a
 * rejected item, list it, archive it, or restore one from the archive.
 *
 * The single exception is `reviewCreatorShopItem`, which is moderatorProcedure —
 * a moderator re-reviewing a rejected item is the way back from a mistaken
 * rejection, and it is not reachable by the creator.
 *
 * Every blocked case asserts BOTH that the call throws and that nothing was
 * written — a guard that throws after mutating would still leave the item
 * laundered, and the throw alone can't tell those apart.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shopItemFindUnique: vi.fn(),
    shopItemUpdate: vi.fn(),
    refreshOwnedStickerCache: vi.fn(),
    createNotification: vi.fn(),
  },
}));

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

import {
  archiveCreatorShopItem,
  reviewCreatorShopItem,
  setCreatorShopItemListed,
  unarchiveCreatorShopItem,
  updateCreatorShopItem,
} from '../creator-shop.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { wasLastReviewARejection } from '../creator-shop.data';

dbMock.dbRead.cosmeticShopItem.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmeticShopItem.update.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemUpdate as (...a: unknown[]) => unknown)(...args)
);

const reviewed = (action: string, at: string) => ({
  at,
  userId: 99,
  kind: 'reviewed' as const,
  status: action === 'reject' ? 'Rejected' : 'RequestedChanges',
  action,
  note: 'not a fit for the shop',
});

const item = (status: string, history: unknown[]) => ({
  id: 42,
  cosmeticId: 7,
  unitAmount: 500,
  status,
  title: 'Golden Laurel',
  description: 'A laurel',
  availableQuantity: null,
  addedById: 11,
  meta: { history },
  cosmetic: {
    id: 7,
    createdById: 11,
    type: 'Badge',
    data: { url: 'art' },
    creator: { username: 'creator' },
  },
  _count: { purchases: 0 },
});

const REJECTED = item('Rejected', [reviewed('reject', '2026-08-02T00:00:00.000Z')]);
const CHANGES_REQUESTED = item('RequestedChanges', [
  reviewed('request-changes', '2026-08-02T00:00:00.000Z'),
]);

const FINAL = /Rejected items are final/;

describe('a rejected item is terminal', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 42,
      ...data,
    }));
  });

  it('cannot be edited', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(REJECTED);
    await expect(updateCreatorShopItem({ id: 42, userId: 11, price: 900 })).rejects.toThrow(FINAL);
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
  });

  // Listing resets status to PendingReview and clears the verdict, so this is a
  // re-entry into the queue with no edit at all.
  it('cannot be listed back onto sale', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(REJECTED);
    await expect(setCreatorShopItemListed({ id: 42, userId: 11, listed: true })).rejects.toThrow(
      FINAL
    );
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
  });

  // Archive → restore was the two-click version of the same laundering: restoring
  // sets PendingReview and clears the verdict.
  it('cannot be archived', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(REJECTED);
    await expect(archiveCreatorShopItem({ id: 42, userId: 11 })).rejects.toThrow(FINAL);
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
  });

  // Archiving a rejected item is refused now, but rows archived before that was
  // true still exist — Archived overwrote their status, so only the history says
  // they were rejected.
  it('cannot be restored when it was archived after being rejected', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(
      item('Archived', [reviewed('reject', '2026-08-02T00:00:00.000Z')])
    );
    await expect(unarchiveCreatorShopItem({ id: 42, userId: 11 })).rejects.toThrow(FINAL);
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
  });

  // Older than the history log: the verdict that archived it is unknowable, and
  // an unknown verdict must not become a resubmission.
  it('cannot be restored by its creator when it predates the history log', async () => {
    mocks.shopItemFindUnique.mockResolvedValue({
      ...item('Archived', []),
      rejectionReason: 'not a fit for the shop',
    });
    await expect(unarchiveCreatorShopItem({ id: 42, userId: 11 })).rejects.toThrow(FINAL);
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
  });

  // The carve-out is the REVIEW path and nothing else: a moderator who wants to
  // change a rejected item reopens it first, which leaves a history entry.
  it('is terminal on the creator-reachable paths even for a moderator', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(REJECTED);
    await expect(
      updateCreatorShopItem({ id: 42, userId: 500, isModerator: true, price: 900 })
    ).rejects.toThrow(FINAL);
    await expect(
      archiveCreatorShopItem({ id: 42, userId: 500, isModerator: true })
    ).rejects.toThrow(FINAL);
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
  });
});

// Controls: the same calls on an item that was NOT rejected still go through, so
// a guard that over-reaches to every reviewed item fails here rather than
// silently freezing the request-changes loop this queue runs on.
describe('only a moderator can reopen a rejection', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 42,
      ...data,
    }));
    mocks.shopItemFindUnique.mockResolvedValue(REJECTED);
  });

  it.each([
    ['request-changes', 'RequestedChanges'],
    ['approve', 'Published'],
  ] as const)('re-reviewing it as %s moves it to %s', async (action, status) => {
    await reviewCreatorShopItem({
      id: 42,
      reviewerId: 99,
      action,
      rejectionReason: 'reopened on appeal',
    });
    expect(mocks.shopItemUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status }) })
    );
  });

  // The same unknowable legacy row a creator is refused: a moderator can read the
  // reason and decide, which is the only way one of these ever moves again.
  it('a moderator can restore a pre-history archived item the creator cannot', async () => {
    mocks.shopItemFindUnique.mockResolvedValue({
      ...item('Archived', []),
      rejectionReason: 'not a fit for the shop',
    });
    await unarchiveCreatorShopItem({ id: 42, userId: 500, isModerator: true });
    expect(mocks.shopItemUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PendingReview' }) })
    );
  });

  it('records the reopening in the history, so the first rejection is not lost', async () => {
    await reviewCreatorShopItem({
      id: 42,
      reviewerId: 99,
      action: 'request-changes',
      rejectionReason: 'reopened on appeal',
    });
    const history = mocks.shopItemUpdate.mock.calls[0][0].data.meta.history;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ action: 'reject' });
    expect(history[1]).toMatchObject({
      userId: 99,
      kind: 'reviewed',
      action: 'request-changes',
      note: 'reopened on appeal',
    });
  });
});

describe('an item that was only sent back for changes still moves', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 42,
      ...data,
    }));
    mocks.shopItemFindUnique.mockResolvedValue(CHANGES_REQUESTED);
  });

  it('can be archived', async () => {
    await archiveCreatorShopItem({ id: 42, userId: 11 });
    expect(mocks.shopItemUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'Archived' }) })
    );
  });

  it('can be reviewed again', async () => {
    await reviewCreatorShopItem({
      id: 42,
      reviewerId: 99,
      action: 'request-changes',
      rejectionReason: 'one more pass please',
    });
    expect(mocks.shopItemUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RequestedChanges' }) })
    );
  });

  it('can be restored from the archive', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(
      item('Archived', [reviewed('request-changes', '2026-08-02T00:00:00.000Z')])
    );
    await unarchiveCreatorShopItem({ id: 42, userId: 11 });
    expect(mocks.shopItemUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PendingReview' }) })
    );
  });
});

describe('wasLastReviewARejection', () => {
  const entry = (kind: string, action?: string) =>
    ({ at: '2026-08-02T00:00:00.000Z', userId: 99, kind, action } as never);

  it('reads the LAST verdict, not any of them', () => {
    expect(wasLastReviewARejection([entry('reviewed', 'reject')])).toBe(true);
    // A rejection that was itself reverted is not what the item ended on.
    expect(
      wasLastReviewARejection([entry('reviewed', 'reject'), entry('reviewed', 'approve')])
    ).toBe(false);
  });

  it('looks past the edits that follow a verdict', () => {
    expect(wasLastReviewARejection([entry('reviewed', 'reject'), entry('edited')])).toBe(true);
  });

  it('is false when nothing was ever reviewed', () => {
    expect(wasLastReviewARejection(undefined)).toBe(false);
    expect(wasLastReviewARejection([])).toBe(false);
    expect(wasLastReviewARejection([entry('submitted')])).toBe(false);
  });
});
