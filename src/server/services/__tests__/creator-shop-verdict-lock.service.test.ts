/**
 * Moderator verdicts and listing changes write `meta` whole. Each builds it from the row as read
 * under a row lock, so an edit or refund that committed after an earlier read survives, and a
 * verdict pinned to the version the moderator reviewed is refused once that version has moved.
 *
 * The fake transaction answers with the row as it stands after a concurrent write (`locked`), while
 * every read outside it still returns the row from before (`stale`), as a lagging replica or an
 * earlier read on the primary would.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    createNotification: vi.fn(),
    refreshOwnedStickerCache: vi.fn(),
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
} from '../creator-shop.service';
import { updateCreatorShopPack } from '../creator-shop-pack.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { COVER_IMAGE_UNAVAILABLE_MESSAGE } from '~/server/services/image-url-ownership';
import { takenImageKeyFake } from './image-url-ownership.fake';

const submitted = {
  at: '2026-10-01T00:00:00.000Z',
  userId: 11,
  kind: 'submitted',
  status: 'PendingReview',
};
const artSwapped = {
  at: '2026-10-03T00:00:00.000Z',
  userId: 11,
  kind: 'edited',
  status: 'PendingReview',
  changes: [{ field: 'artwork', from: 'old-art', to: 'new-art' }],
};
const refundRun = {
  at: '2026-10-03T00:00:00.000Z',
  userId: 99,
  kind: 'refunded',
  note: '1 refunded',
};

const row = (status: string, meta: Record<string, unknown>) => ({
  id: 42,
  cosmeticId: 7,
  unitAmount: 500,
  status,
  title: 'Golden Laurel',
  description: 'A laurel',
  availableQuantity: null,
  addedById: 11,
  itemDefinitionId: null,
  itemDefinition: null,
  rejectionReason: null,
  meta,
  cosmetic: {
    id: 7,
    createdById: 11,
    type: 'Badge',
    data: { url: 'old-art' },
    creator: { username: 'creator' },
  },
  _count: { purchases: 0 },
});

const lock = vi.fn();
const lockedRead = vi.fn();
const update = dbMock.dbWrite.cosmeticShopItem.update;

/** `stale` outside the transaction, `locked` inside it, answered only once the row lock is taken. */
const rows = (stale: ReturnType<typeof row>, locked: ReturnType<typeof row>) => {
  dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue(stale as never);
  dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue(stale as never);
  lockedRead.mockImplementation(() => {
    if (!lock.mock.calls.some(([values]) => values[0] === 42))
      throw new Error('read the row before locking it');
    return locked;
  });
};

const writtenMeta = () =>
  (update.mock.calls.at(-1)?.[0] as { data: { meta?: { history?: { kind: string }[] } } })?.data
    .meta;

beforeEach(() => {
  lock.mockReset();
  lockedRead.mockReset();
  update.mockReset();
  update.mockImplementation((({ data }: { data: Record<string, unknown> }) => ({
    id: 42,
    ...data,
  })) as never);
  mocks.createNotification.mockReset();
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join('?').includes('FOR NO KEY UPDATE')) lock(values);
        return [];
      },
      $executeRaw: async () => 0,
      cosmeticShopItem: { findUnique: lockedRead, update },
    })) as never);
});

describe('a verdict pinned to the version the moderator reviewed', () => {
  const before = row('PendingReview', { imageHash: 'old', history: [submitted] });
  const after = row('PendingReview', { imageHash: 'new', history: [submitted, artSwapped] });

  it('is refused when the artwork was replaced after the queue loaded, and writes nothing', async () => {
    rows(before, after);
    await expect(
      reviewCreatorShopItem({
        id: 42,
        reviewerId: 99,
        action: 'approve',
        stickersEnabled: false,
        reviewedVersion: submitted.at,
      })
    ).rejects.toThrow(/changed since you opened it/);
    expect(update).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  // The pin is the last history entry, which a refund run appends to as well. That costs the
  // moderator a reload; it is the price of also covering price and text edits, not a bug to fix.
  it('is refused when a refund run appended history after the queue loaded', async () => {
    rows(before, row('PendingReview', { imageHash: 'old', history: [submitted, refundRun] }));
    await expect(
      reviewCreatorShopItem({
        id: 42,
        reviewerId: 99,
        action: 'approve',
        stickersEnabled: false,
        reviewedVersion: submitted.at,
      })
    ).rejects.toThrow(/changed since you opened it/);
    expect(update).not.toHaveBeenCalled();
  });

  // `null` is a real version (an item with no history yet), not a missing pin.
  it('is refused when the item had no history when opened and has some now', async () => {
    rows(row('PendingReview', { imageHash: 'old' }), after);
    await expect(
      reviewCreatorShopItem({
        id: 42,
        reviewerId: 99,
        action: 'approve',
        stickersEnabled: false,
        reviewedVersion: null,
      })
    ).rejects.toThrow(/changed since you opened it/);
    expect(update).not.toHaveBeenCalled();
  });

  it('revert is refused when the item left Published since it was read', async () => {
    rows(
      row('Published', { history: [submitted] }),
      row('PendingReview', { history: [submitted] })
    );
    await expect(
      reviewCreatorShopItem({
        id: 42,
        reviewerId: 99,
        action: 'revert',
        rejectionReason: 'needs another look',
        stickersEnabled: false,
        reviewedVersion: submitted.at,
      })
    ).rejects.toThrow(/Only published items/);
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps the edit the moderator reviewed, when the replica has not caught up with it', async () => {
    rows(before, after);
    await reviewCreatorShopItem({
      id: 42,
      reviewerId: 99,
      action: 'approve',
      stickersEnabled: false,
      reviewedVersion: artSwapped.at,
    });
    const meta = writtenMeta() as { imageHash?: string; history?: { kind: string }[] };
    expect(meta.history?.map((e) => e.kind)).toEqual(['submitted', 'edited', 'reviewed']);
    expect(meta.imageHash).toBe('new');
  });
});

describe('a listing change made while another write commits', () => {
  it('re-listing keeps the history entry committed since the item was read', async () => {
    rows(
      row('Published', { history: [submitted] }),
      row('Published', { history: [submitted, refundRun] })
    );
    await setCreatorShopItemListed({ id: 42, userId: 11, listed: true });
    expect(writtenMeta()?.history?.map((e) => e.kind)).toEqual(['submitted', 'refunded']);
  });

  it('re-listing is refused when a rejection landed since the item was read', async () => {
    rows(row('Published', { history: [submitted] }), row('Rejected', { history: [submitted] }));
    await expect(setCreatorShopItemListed({ id: 42, userId: 11, listed: true })).rejects.toThrow(
      /Rejected items are final/
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('restoring is refused when a takedown landed since the item was read', async () => {
    rows(
      row('Archived', { history: [submitted] }),
      row('Archived', {
        history: [submitted],
        takedown: { reason: 'IP', moderatorId: 99, at: '2026-10-03T00:00:00.000Z' },
      })
    );
    await expect(unarchiveCreatorShopItem({ id: 42, userId: 11 })).rejects.toThrow(/taken down/);
    expect(update).not.toHaveBeenCalled();
  });

  // Withheld decides whether the archive refunds the buyers, so it must be judged on the row as it
  // stands: here an edit pulled the item back into review after it was read as Published.
  it('archiving refunds buyers of an item withheld since it was read, keeping its history', async () => {
    rows(
      row('Published', { history: [submitted] }),
      row('PendingReview', { displayApproved: false, history: [submitted, artSwapped] })
    );
    await archiveCreatorShopItem({ id: 42, userId: 11 });
    expect(writtenMeta()).toMatchObject({
      withdrawnRefund: { trigger: 'archive' },
      history: [{ kind: 'submitted' }, { kind: 'edited' }],
    });
  });

  it('restoring keeps the history entry committed since the item was read', async () => {
    rows(
      row('Archived', { history: [submitted] }),
      row('Archived', { history: [submitted, refundRun] })
    );
    await unarchiveCreatorShopItem({ id: 42, userId: 11 });
    expect(writtenMeta()?.history?.map((e) => e.kind)).toEqual(['submitted', 'refunded']);
  });

  it('archiving is refused when a rejection landed since the item was read, and writes nothing', async () => {
    const rejected = {
      at: '2026-10-03T00:00:00.000Z',
      userId: 99,
      kind: 'reviewed',
      status: 'Rejected',
      action: 'reject',
    };
    rows(
      row('Published', { history: [submitted] }),
      row('Rejected', { history: [submitted, rejected] })
    );
    await expect(archiveCreatorShopItem({ id: 42, userId: 11 })).rejects.toThrow(
      /Rejected items are final/
    );
    expect(update).not.toHaveBeenCalled();
  });
});

describe('a bundle pack edited while it is being reviewed', () => {
  const pack = (status: string, meta: Record<string, unknown>) => ({
    ...row(status, meta),
    cosmeticId: null,
    cosmetic: null,
    members: [{ cosmeticId: 5 }, { cosmeticId: 6 }],
  });
  const rejected = {
    at: '2026-10-03T00:00:00.000Z',
    userId: 99,
    kind: 'reviewed',
    status: 'Rejected',
    action: 'reject',
  };

  it('moves the version, so a verdict on the pack as first loaded is refused', async () => {
    const loaded = pack('PendingReview', { coverUrl: 'old-cover', history: [submitted] });
    rows(loaded, loaded);
    await updateCreatorShopPack({ id: 42, userId: 11, name: 'Bait title' });
    const edited = writtenMeta();
    expect(edited?.history?.at(-1)).toMatchObject({
      kind: 'edited',
      changes: [{ field: 'name', from: 'Golden Laurel', to: 'Bait title' }],
    });

    update.mockClear();
    rows(loaded, { ...loaded, title: 'Bait title', meta: edited as Record<string, unknown> });
    await expect(
      reviewCreatorShopItem({
        id: 42,
        reviewerId: 99,
        action: 'approve',
        stickersEnabled: false,
        reviewedVersion: submitted.at,
      })
    ).rejects.toThrow(/changed since you opened it/);
    expect(update).not.toHaveBeenCalled();
  });

  // Its changes were measured against the earlier read; recorded against a moved row, an edit could
  // change what a moderator reviewed without moving the version.
  it('is refused when the pack moved since it was read, and writes nothing', async () => {
    rows(
      pack('PendingReview', { history: [submitted] }),
      pack('PendingReview', { history: [submitted, refundRun] })
    );
    await expect(updateCreatorShopPack({ id: 42, userId: 11, name: 'Bait title' })).rejects.toThrow(
      /changed while you were editing/
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a cover key already in use, checked as the pack owner's and excluding the pack", async () => {
    const loaded = pack('PendingReview', { history: [submitted] });
    rows(loaded, loaded);
    const probes: unknown[][] = [];
    const original = dbMock.dbWrite.$queryRaw.getMockImplementation();
    dbMock.dbWrite.$queryRaw.mockImplementation(takenImageKeyFake(probes));
    try {
      await expect(
        updateCreatorShopPack({
          id: 42,
          userId: 99,
          isModerator: true,
          imageUrl: '0a0b0c0d-0000-4000-8000-0000000000aa',
        })
      ).rejects.toThrow(COVER_IMAGE_UNAVAILABLE_MESSAGE);
    } finally {
      dbMock.dbWrite.$queryRaw.mockImplementation(original as never);
    }
    expect(update).not.toHaveBeenCalled();
    // Bound as: keys, owner, keys, own cosmetic, keys, own pack, keys, own box.
    expect(probes).toHaveLength(1);
    expect([probes[0][1], probes[0][3], probes[0][5], probes[0][7]]).toEqual([11, null, 42, null]);
  });

  it('does not re-check a cover the edit resends unchanged', async () => {
    const cover = '0a0b0c0d-0000-4000-8000-0000000000aa';
    const loaded = pack('PendingReview', { coverUrl: cover, history: [submitted] });
    rows(loaded, loaded);
    const probes: unknown[][] = [];
    const original = dbMock.dbWrite.$queryRaw.getMockImplementation();
    dbMock.dbWrite.$queryRaw.mockImplementation(takenImageKeyFake(probes));
    try {
      await updateCreatorShopPack({ id: 42, userId: 11, name: 'New title', imageUrl: cover });
    } finally {
      dbMock.dbWrite.$queryRaw.mockImplementation(original as never);
    }
    expect(probes).toHaveLength(0);
    expect(update).toHaveBeenCalled();
  });

  it('carries a sale counted since it was read', async () => {
    rows(
      pack('PendingReview', { purchases: 3, history: [submitted] }),
      pack('PendingReview', { purchases: 4, history: [submitted] })
    );
    await updateCreatorShopPack({ id: 42, userId: 11, name: 'New title' });
    expect(writtenMeta()).toMatchObject({ purchases: 4 });
  });

  // Writing the replica's copy back would erase the rejection and return the pack to the queue.
  it('is refused when a rejection landed since the replica read, and writes nothing', async () => {
    rows(
      pack('PendingReview', { history: [submitted] }),
      pack('Rejected', { history: [submitted, rejected] })
    );
    await expect(updateCreatorShopPack({ id: 42, userId: 11, name: 'Bait title' })).rejects.toThrow(
      /Rejected items are final/
    );
    expect(update).not.toHaveBeenCalled();
  });
});
