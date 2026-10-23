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
import { dbMock } from '~/__tests__/mocks/db.mock';

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
    if (!lock.mock.calls.length) throw new Error('read the row before locking it');
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
