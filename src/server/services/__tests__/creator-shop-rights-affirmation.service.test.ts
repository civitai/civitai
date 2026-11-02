import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageUrlOwnership from '~/server/services/image-url-ownership';
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

const { assertUsableSpy } = vi.hoisted(() => ({ assertUsableSpy: vi.fn() }));
vi.mock('~/server/services/image-url-ownership', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageUrlOwnership>();
  assertUsableSpy.mockImplementation(actual.assertClientImageUrlsUsable);
  return { ...actual, assertClientImageUrlsUsable: assertUsableSpy };
});
vi.mock('sharp', () => ({
  default: () => ({ metadata: mocks.sharpMetadata }),
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mocks.createBuzzTransaction,
  refundTransaction: mocks.refundTransaction,
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

import { submitCreatorShopItem, updateCreatorShopItem } from '../creator-shop.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { COVER_IMAGE_UNAVAILABLE_MESSAGE } from '~/server/services/image-url-ownership';
import { takenImageKeyFake } from './image-url-ownership.fake';
dbMock.dbRead.cosmeticShopItem.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmeticShopItem.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmeticShopItem.update.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemUpdate as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
  cb({
    $queryRaw: dbMock.dbWrite.$queryRaw,
    cosmetic: { create: mocks.cosmeticCreate, update: dbMock.dbWrite.cosmetic.update },
    cosmeticShopItem: {
      create: mocks.shopItemCreate,
      findUnique: dbMock.dbWrite.cosmeticShopItem.findUnique,
      update: dbMock.dbWrite.cosmeticShopItem.update,
    },
  })
);

// Shop artwork is a bare upload key; this one's issue record names the caller.
const ART_KEY = '1a2b3c4d-0000-4000-8000-0000000000bb';
beforeEach(() => {
  redisMock.sysRedis.mGet.mockResolvedValue(['11'] as never);
});

const submitInput = {
  cosmeticType: CosmeticType.Badge,
  name: 'Golden Laurel',
  description: null,
  imageUrl: ART_KEY,
  price: 500,
  availableQuantity: null,
  buzzType: 'yellow',
  sellableByOthers: false,
  sellerShare: 0,
  acceptsBlueBuzz: false,
  rightsAffirmed: true,
  quotedFee: 10000,
} as const;

describe('rights affirmation input contract', () => {
  const base = {
    cosmeticType: CosmeticType.Badge,
    name: 'Golden Laurel',
    imageUrl: ART_KEY,
    price: 500,
    quotedFee: 10000,
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
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      })
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
    await expect(updateCreatorShopItem({ id: 42, userId: 11, imageUrl: ART_KEY })).rejects.toThrow(
      /rights to sell/
    );
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
  });

  it('leaves the recorded affirmation alone on a price-only edit', async () => {
    await updateCreatorShopItem({ id: 42, userId: 11, price: 600 });

    const meta = mocks.shopItemUpdate.mock.calls[0][0].data.meta;
    expect(meta.rightsAffirmation).toEqual(existing.meta.rightsAffirmation);
  });
});

describe('artwork key already in use', () => {
  const KEY = '0a0b0c0d-0000-4000-8000-0000000000aa';
  const original = dbMock.dbWrite.$queryRaw.getMockImplementation();
  let probes: unknown[][];

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
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      })
    );
    probes = [];
    dbMock.dbWrite.$queryRaw.mockImplementation(takenImageKeyFake(probes));
  });
  afterEach(() => {
    dbMock.dbWrite.$queryRaw.mockImplementation(original as never);
  });

  it('refuses a submission before charging the fee', async () => {
    await expect(
      submitCreatorShopItem({ ...submitInput, imageUrl: KEY, userId: 11 })
    ).rejects.toThrow(COVER_IMAGE_UNAVAILABLE_MESSAGE);
    expect(probes).toHaveLength(1);
    // Checked as a shop write: no image row may hold the key, the creator's own included.
    expect(assertUsableSpy).toHaveBeenCalledWith(expect.objectContaining({ shopRow: {} }));
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(mocks.cosmeticCreate).not.toHaveBeenCalled();
  });

  it("refuses an artwork swap, checked as the creator's and excluding the item's own cosmetic", async () => {
    mocks.shopItemFindUnique.mockResolvedValue({
      id: 42,
      cosmeticId: 7,
      unitAmount: 500,
      status: 'PendingReview',
      meta: {},
      addedById: 11,
      cosmetic: { id: 7, createdById: 11, type: 'Badge', data: {} },
      _count: { purchases: 0 },
    });

    await expect(
      updateCreatorShopItem({
        id: 42,
        userId: 99,
        isModerator: true,
        imageUrl: KEY,
        rightsAffirmed: true,
      })
    ).rejects.toThrow(COVER_IMAGE_UNAVAILABLE_MESSAGE);
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
    expect(probes).toHaveLength(1);
    expect(assertUsableSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 11, shopRow: { cosmeticId: 7 } })
    );
  });
});

describe('artwork key issued to someone else', () => {
  const KEY = '0a0b0c0d-0000-4000-8000-0000000000aa';
  const original = dbMock.dbWrite.$queryRaw.getMockImplementation();

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
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(8),
      })
    );
    // No row holds the key: only its issue record can refuse it.
    dbMock.dbWrite.$queryRaw.mockImplementation((async () => []) as never);
    redisMock.sysRedis.mGet.mockResolvedValue(['55'] as never);
  });
  afterEach(() => {
    dbMock.dbWrite.$queryRaw.mockImplementation(original as never);
    redisMock.sysRedis.mGet.mockReset();
  });

  it('refuses a submission before charging the fee', async () => {
    await expect(
      submitCreatorShopItem({ ...submitInput, imageUrl: KEY, userId: 11 })
    ).rejects.toThrow(COVER_IMAGE_UNAVAILABLE_MESSAGE);
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(mocks.cosmeticCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['refuses', 'a key issued to neither them nor the creator', '55'],
    ['accepts', "the creator's key", '11'],
  ])("%s a moderator's artwork swap to %s", async (verdict, _, issuedTo) => {
    redisMock.sysRedis.mGet.mockResolvedValue([issuedTo] as never);
    mocks.shopItemFindUnique.mockResolvedValue({
      id: 42,
      cosmeticId: 7,
      unitAmount: 500,
      status: 'PendingReview',
      meta: {},
      addedById: 11,
      cosmetic: { id: 7, createdById: 11, type: 'Badge', data: {} },
      _count: { purchases: 0 },
    });

    const swap = updateCreatorShopItem({
      id: 42,
      userId: 99,
      isModerator: true,
      imageUrl: KEY,
      rightsAffirmed: true,
    });
    if (verdict === 'refuses') await expect(swap).rejects.toThrow(COVER_IMAGE_UNAVAILABLE_MESSAGE);
    else await swap;
    expect(mocks.shopItemUpdate).toHaveBeenCalledTimes(verdict === 'refuses' ? 0 : 1);
  });
});
