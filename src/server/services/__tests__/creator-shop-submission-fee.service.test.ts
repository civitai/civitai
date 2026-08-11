import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmeticType } from '~/shared/utils/prisma/enums';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    keyValueFindUnique: vi.fn(),
    cosmeticCreate: vi.fn(),
    shopItemCreate: vi.fn(),
    packMemberCreate: vi.fn(),
    shopItemFindMany: vi.fn(),
    createBuzzTransaction: vi.fn(),
    refundTransaction: vi.fn(),
    sharpMetadata: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmeticShopItem: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: mocks.shopItemFindMany },
  },
  dbWrite: {
    keyValue: { findUnique: mocks.keyValueFindUnique },
    cosmeticShopItem: { update: vi.fn() },
    $transaction: (cb: (tx: unknown) => unknown) =>
      cb({
        cosmetic: { create: mocks.cosmeticCreate },
        cosmeticShopItem: { create: mocks.shopItemCreate },
        cosmeticShopItemCosmetic: { createMany: mocks.packMemberCreate },
      }),
  },
}));
vi.mock('sharp', () => ({ default: () => ({ metadata: mocks.sharpMetadata }) }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mocks.createBuzzTransaction,
  refundTransaction: mocks.refundTransaction,
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

const { submitCreatorShopItem } = await import('../creator-shop.service');
const { submitCreatorShopPack } = await import('../creator-shop-pack.service');

const submitInput = {
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
  userId: 11,
} as const;

const packInput = {
  userId: 11,
  name: 'Laurels',
  description: null,
  price: 1000,
  availableQuantity: null,
  buzzType: 'yellow',
  acceptsBlueBuzz: false,
} as const;

const chargedAmount = () => mocks.createBuzzTransaction.mock.calls[0][0].amount;
const recordedFee = (create: typeof mocks.shopItemCreate) =>
  create.mock.calls[0][0].data.meta.submissionFee;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.keyValueFindUnique.mockResolvedValue(null);
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
  mocks.shopItemFindMany.mockResolvedValue([]);
});

describe('submission fee charged', () => {
  it('charges the type its own configured fee, not a shared one', async () => {
    mocks.keyValueFindUnique.mockResolvedValue({
      key: 'creatorShopFees',
      value: { submission: { Badge: 5000 } },
    });

    await submitCreatorShopItem({
      ...submitInput,
      cosmeticType: CosmeticType.Badge,
      quotedFee: 5000,
    });

    expect(chargedAmount()).toBe(5000);
    expect(recordedFee(mocks.shopItemCreate)).toBe(5000);
  });

  it('charges a type the row does not mention its 10000 default', async () => {
    mocks.keyValueFindUnique.mockResolvedValue({
      key: 'creatorShopFees',
      value: { submission: { Badge: 5000 } },
    });

    await submitCreatorShopItem({
      ...submitInput,
      cosmeticType: CosmeticType.ProfileDecoration,
      quotedFee: 10000,
    });

    expect(chargedAmount()).toBe(10000);
    expect(recordedFee(mocks.shopItemCreate)).toBe(10000);
  });

  it('charges 10000 with no configuration at all', async () => {
    await submitCreatorShopItem({
      ...submitInput,
      cosmeticType: CosmeticType.Badge,
      quotedFee: 10000,
    });
    expect(chargedAmount()).toBe(10000);
  });

  // The fee is taken before the item exists; if the read fails after the charge the
  // creator has paid for nothing, so nothing may be charged until the fee is known.
  it('charges nothing when the fee cannot be resolved', async () => {
    mocks.keyValueFindUnique.mockRejectedValue(new Error('KeyValue unavailable'));

    await expect(
      submitCreatorShopItem({
        ...submitInput,
        cosmeticType: CosmeticType.Badge,
        quotedFee: 10000,
      })
    ).rejects.toThrow('KeyValue unavailable');
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
  });

  // The form is a quote, not a suggestion: a modal left open across a fee change
  // must not be charged the number the creator never saw, in either direction.
  it('refuses the submission when the quoted fee no longer matches', async () => {
    mocks.keyValueFindUnique.mockResolvedValue({
      key: 'creatorShopFees',
      value: { submission: { Badge: 5000 } },
    });

    await expect(
      submitCreatorShopItem({
        ...submitInput,
        cosmeticType: CosmeticType.Badge,
        quotedFee: 10000,
      })
    ).rejects.toThrow(/fee changed/i);
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(mocks.shopItemCreate).not.toHaveBeenCalled();
  });

  it('refuses a quote above the configured fee too', async () => {
    mocks.keyValueFindUnique.mockResolvedValue({
      key: 'creatorShopFees',
      value: { submission: { Badge: 12000 } },
    });

    await expect(
      submitCreatorShopItem({
        ...submitInput,
        cosmeticType: CosmeticType.Badge,
        quotedFee: 10000,
      })
    ).rejects.toThrow(/fee changed/i);
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
  });
});

describe('pack submission fee charged', () => {
  const members = [1, 2];

  beforeEach(() => {
    mocks.shopItemFindMany.mockResolvedValue(
      members.map((id) => ({
        cosmeticId: id,
        unitAmount: 500,
        meta: { acceptsBlueBuzz: false },
        cosmetic: {
          id,
          name: `member ${id}`,
          type: CosmeticType.Badge,
          data: {},
          createdById: 11,
          creator: { username: 'me' },
        },
      }))
    );
    mocks.shopItemCreate.mockResolvedValue({ id: 1 });
  });

  it('charges the configured pack fee', async () => {
    mocks.keyValueFindUnique.mockResolvedValue({ key: 'creatorShopFees', value: { pack: 2500 } });

    await submitCreatorShopPack({ ...packInput, memberCosmeticIds: members, quotedFee: 2500 });

    expect(chargedAmount()).toBe(2500);
    expect(recordedFee(mocks.shopItemCreate)).toBe(2500);
  });

  it('charges 1000 with no configuration at all', async () => {
    await submitCreatorShopPack({ ...packInput, memberCosmeticIds: members, quotedFee: 1000 });

    expect(chargedAmount()).toBe(1000);
  });

  it('refuses the pack when the quoted fee no longer matches', async () => {
    mocks.keyValueFindUnique.mockResolvedValue({ key: 'creatorShopFees', value: { pack: 2500 } });

    await expect(
      submitCreatorShopPack({ ...packInput, memberCosmeticIds: members, quotedFee: 1000 })
    ).rejects.toThrow(/fee changed/i);
    expect(mocks.createBuzzTransaction).not.toHaveBeenCalled();
    expect(mocks.shopItemCreate).not.toHaveBeenCalled();
  });
});
