import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RIGHTS_AFFIRMATION_STATEMENT,
  RIGHTS_AFFIRMATION_VERSION,
  submitCreatorShopItemSchema,
  updateCreatorShopItemSchema,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shopItemFindUnique: vi.fn(),
    shopItemUpdate: vi.fn(),
    cosmeticCreate: vi.fn(),
    shopItemCreate: vi.fn(),
    createBuzzTransaction: vi.fn(),
    refundTransaction: vi.fn(),
    sharpMetadata: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmeticShopItem: { findUnique: mocks.shopItemFindUnique, findFirst: vi.fn() },
  },
  dbWrite: {
    cosmeticShopItem: { update: mocks.shopItemUpdate },
    $transaction: (cb: (tx: unknown) => unknown) =>
      cb({
        cosmetic: { create: mocks.cosmeticCreate },
        cosmeticShopItem: { create: mocks.shopItemCreate },
      }),
  },
}));
vi.mock('sharp', () => ({
  default: () => ({ metadata: mocks.sharpMetadata }),
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mocks.createBuzzTransaction,
  refundTransaction: mocks.refundTransaction,
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

import { submitCreatorShopItem, updateCreatorShopItem } from '../creator-shop.service';

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
} as const;

describe('rights affirmation input contract', () => {
  const base = {
    cosmeticType: CosmeticType.Badge,
    name: 'Golden Laurel',
    imageUrl: 'cf-image-id',
    price: 500,
  };

  it('rejects a submission that omits the affirmation', () => {
    const result = submitCreatorShopItemSchema.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((i) => i.path.includes('rightsAffirmed'))).toBe(true);
  });

  it('rejects a submission that declines the affirmation', () => {
    expect(submitCreatorShopItemSchema.safeParse({ ...base, rightsAffirmed: false }).success).toBe(
      false
    );
  });

  it('accepts a submission that affirms', () => {
    expect(submitCreatorShopItemSchema.safeParse({ ...base, rightsAffirmed: true }).success).toBe(
      true
    );
  });

  // Price/quantity edits don't touch the artwork, so they must not be forced to
  // re-affirm — the service is what requires it on an artwork swap.
  it('leaves the affirmation optional on edits', () => {
    expect(updateCreatorShopItemSchema.safeParse({ id: 1, price: 600 }).success).toBe(true);
    expect(
      updateCreatorShopItemSchema.safeParse({ id: 1, imageUrl: 'new', rightsAffirmed: false })
        .success
    ).toBe(false);
  });
});

describe('submitCreatorShopItem', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
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
    mocks.createBuzzTransaction.mockResolvedValue({ transactionId: 'tx-1' });
    mocks.cosmeticCreate.mockResolvedValue({ id: 99 });
    mocks.shopItemCreate.mockResolvedValue({ id: 1 });
  });

  // The point of the feature: the affirmation has to survive as a record on the
  // item, not just as a checkbox the client ticked.
  it('records who affirmed, what they affirmed, and when', async () => {
    await submitCreatorShopItem({ ...submitInput, userId: 11 });

    const meta = mocks.shopItemCreate.mock.calls[0][0].data.meta;
    expect(meta.rightsAffirmation).toMatchObject({
      userId: 11,
      version: RIGHTS_AFFIRMATION_VERSION,
      statement: RIGHTS_AFFIRMATION_STATEMENT,
    });
    expect(Number.isNaN(Date.parse(meta.rightsAffirmation.affirmedAt))).toBe(false);
  });

  it('never creates an item without one', async () => {
    await expect(
      submitCreatorShopItem({ ...submitInput, rightsAffirmed: false, userId: 11 })
    ).rejects.toThrow(/rights to sell/);
    expect(mocks.shopItemCreate).not.toHaveBeenCalled();
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
  });
});

describe('updateCreatorShopItem', () => {
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
    cosmetic: { id: 7, createdById: 11, type: 'Badge', data: {} },
    _count: { purchases: 0 },
  };

  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindUnique.mockResolvedValue(existing);
    mocks.shopItemUpdate.mockResolvedValue(existing);
  });

  // The stored affirmation describes the art it was made against — swapping the
  // art without a new one would leave a record pointing at artwork that's gone.
  it('rejects an artwork swap without a fresh affirmation', async () => {
    await expect(
      updateCreatorShopItem({ id: 42, userId: 11, imageUrl: 'new-image' })
    ).rejects.toThrow(/rights to sell/);
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
  });

  it('leaves the recorded affirmation alone on a price-only edit', async () => {
    await updateCreatorShopItem({ id: 42, userId: 11, price: 600 });

    const meta = mocks.shopItemUpdate.mock.calls[0][0].data.meta;
    expect(meta.rightsAffirmation).toEqual(existing.meta.rightsAffirmation);
  });
});
