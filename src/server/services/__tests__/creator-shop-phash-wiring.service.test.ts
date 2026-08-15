import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CosmeticPhashService from '~/server/services/cosmetic-phash.service';
import { CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * The creator submission path is how almost every cosmetic now enters the system,
 * and until this wiring existed it was the ONE write path that never hashed:
 * 228 of the 231 unhashed cosmetics in prod on 2026-08-14 came through here.
 *
 * A missing hash does not fail anything — it makes the artwork invisible to
 * similarity review, which looks exactly like a clean comparison. So the
 * assertions here are on the call, not on an outcome: reverting either fix makes
 * a named expectation report zero calls.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shopItemFindUnique: vi.fn(),
    shopItemUpdate: vi.fn(),
    shopItemFindFirst: vi.fn(),
    cosmeticCreate: vi.fn(),
    cosmeticUpdate: vi.fn(),
    shopItemCreate: vi.fn(),
    createBuzzTransaction: vi.fn(),
    refundTransaction: vi.fn(),
    sharpMetadata: vi.fn(),
    queueCosmeticPerceptualHash: vi.fn(),
  },
}));

vi.mock('sharp', () => ({ default: () => ({ metadata: mocks.sharpMetadata }) }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mocks.createBuzzTransaction,
  refundTransaction: mocks.refundTransaction,
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/cosmetic-phash.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticPhashService>()),
  queueCosmeticPerceptualHash: mocks.queueCosmeticPerceptualHash,
}));

import { submitCreatorShopItem, updateCreatorShopItem } from '../creator-shop.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
dbMock.dbRead.cosmeticShopItem.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.cosmeticShopItem.findFirst.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindFirst as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmetic.update.mockImplementation((...args: unknown[]) =>
  (mocks.cosmeticUpdate as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmeticShopItem.update.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemUpdate as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
  cb({
    cosmetic: { create: mocks.cosmeticCreate },
    cosmeticShopItem: { create: mocks.shopItemCreate },
  })
);

const submitInput = {
  cosmeticType: CosmeticType.Badge,
  name: 'Golden Laurel',
  description: null,
  imageUrl: 'cf-image-id',
  price: 500,
  availableQuantity: null,
  buzzType: 'yellow',
  sellableByOthers: false,
  sellerShare: 0,
  acceptsBlueBuzz: false,
  rightsAffirmed: true,
  quotedFee: 10000,
} as const;

const readableArtwork = () => {
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
};

describe('submitCreatorShopItem hashes the artwork it just created', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    readableArtwork();
    mocks.createBuzzTransaction.mockResolvedValue({ transactionId: 'tx-1' });
    mocks.cosmeticCreate.mockResolvedValue({ id: 99 });
    mocks.shopItemCreate.mockResolvedValue({ id: 1 });
    mocks.shopItemFindFirst.mockResolvedValue(null);
  });

  it('queues a hash for the new cosmetic, with the url it was built from', async () => {
    await submitCreatorShopItem({ ...submitInput, userId: 11 });

    expect(mocks.queueCosmeticPerceptualHash).toHaveBeenCalledWith({
      id: 99,
      url: 'cf-image-id',
    });
  });

  it('queues nothing when the submission is rejected before the write', async () => {
    // A hash for a cosmetic that was never created would be a write against
    // someone else's id, and the fee is refunded rather than charged.
    await expect(
      submitCreatorShopItem({ ...submitInput, rightsAffirmed: false, userId: 11 })
    ).rejects.toThrow(/rights to sell/);

    expect(mocks.queueCosmeticPerceptualHash).not.toHaveBeenCalled();
  });
});

describe('updateCreatorShopItem re-hashes swapped artwork', () => {
  const existing = {
    id: 42,
    cosmeticId: 7,
    unitAmount: 500,
    status: 'PendingReview',
    meta: {
      rightsAffirmation: {
        userId: 11,
        affirmedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        statement: 'old wording',
      },
    },
    addedById: 11,
    cosmetic: { id: 7, createdById: 11, type: 'Badge', data: { url: 'old-image' } },
    _count: { purchases: 0 },
  };

  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    readableArtwork();
    mocks.shopItemFindUnique.mockResolvedValue(existing);
    mocks.shopItemUpdate.mockResolvedValue(existing);
    mocks.shopItemFindFirst.mockResolvedValue(null);
    mocks.cosmeticUpdate.mockResolvedValue({ id: 7 });
  });

  // This path writes `data.url` with a raw update that never goes through
  // updateCosmetic, so nothing else re-hashes it. Left alone, the old hash
  // survives against artwork that has been replaced — a stale hash asserts a
  // similarity to an image nobody can see.
  it('queues a hash for the replacement artwork', async () => {
    await updateCreatorShopItem({
      id: 42,
      userId: 11,
      imageUrl: 'new-image',
      rightsAffirmed: true,
    });

    expect(mocks.queueCosmeticPerceptualHash).toHaveBeenCalledWith({
      id: 7,
      url: 'new-image',
    });
  });

  it('leaves the existing hash alone when only the price moves', async () => {
    await updateCreatorShopItem({ id: 42, userId: 11, price: 600 });

    expect(mocks.queueCosmeticPerceptualHash).not.toHaveBeenCalled();
  });
});
