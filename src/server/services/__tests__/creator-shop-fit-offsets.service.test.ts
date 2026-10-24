/**
 * Fit offsets have two ranges: a creator may set an edge to ±20px, a moderator to ±50px. The zod
 * schema carries the outer ceiling (a moderator calls the same procedures), so the creator range
 * is a service rule — and a value a moderator pushed past it must survive a creator's later edit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import {
  cosmeticOffsetsSchema,
  updateCreatorShopItemSchema,
} from '~/server/schema/creator-shop.schema';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shopItemFindUnique: vi.fn(),
    shopItemUpdate: vi.fn(),
    cosmeticUpdate: vi.fn(),
    sharpMetadata: vi.fn(),
  },
}));

vi.mock('sharp', () => ({ default: () => ({ metadata: mocks.sharpMetadata }) }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  refreshOwnedStickerCache: vi.fn(),
}));

import { submitCreatorShopItem, updateCreatorShopItem } from '../creator-shop.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

dbMock.dbRead.cosmeticShopItem.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmeticShopItem.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmeticShopItem.update.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemUpdate as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmetic.update.mockImplementation((...args: unknown[]) =>
  (mocks.cosmeticUpdate as (...a: unknown[]) => unknown)(...args)
);

const edges = (value: number) => ({ top: value, right: value, bottom: value, left: value });
const MOD_SET = { top: -40, right: -40, bottom: -40, left: -40 };

const OFFSETS_MESSAGE = /Fit offsets can be at most 20px/;

const frame = (offsets?: Record<string, number>) => ({
  id: 42,
  cosmeticId: 7,
  unitAmount: 500,
  status: 'PendingReview',
  title: 'Golden Frame',
  description: 'A frame',
  availableQuantity: null,
  addedById: 11,
  meta: {},
  cosmetic: {
    id: 7,
    createdById: 11,
    type: 'ProfileDecoration',
    data: { url: 'art', ...(offsets ? { offsets } : {}) },
    creator: { username: 'creator' },
  },
  _count: { purchases: 0 },
});

const writtenOffsets = () => {
  const call = mocks.cosmeticUpdate.mock.calls.at(-1)?.[0];
  return call?.data?.data?.offsets;
};

describe('the schema takes the moderator ceiling and no more', () => {
  it.each([-50, -20, 0, 5, 50])('accepts %i on every edge', (value) => {
    expect(cosmeticOffsetsSchema.safeParse(edges(value)).success).toBe(true);
  });

  it.each([-51, 51, 2.5])('refuses %s', (value) => {
    expect(cosmeticOffsetsSchema.safeParse({ ...edges(0), left: value }).success).toBe(false);
  });

  it('lets a moderator update through the shared procedure input at -50', () => {
    expect(updateCreatorShopItemSchema.safeParse({ id: 42, offsets: edges(-50) }).success).toBe(
      true
    );
  });
});

describe('a creator submitting a frame', () => {
  it('is refused past 20 on any edge, before anything else runs', async () => {
    await expect(
      submitCreatorShopItem({
        userId: 11,
        offsets: { ...edges(0), bottom: -21 },
      } as never)
    ).rejects.toThrow(OFFSETS_MESSAGE);
  });

  // Positive control: at exactly 20 the same call goes on to the next check, which this call fails
  // on purpose — so the refusal above is the range, not something else in the submit.
  it('gets past the range check at exactly 20', async () => {
    await expect(
      submitCreatorShopItem({
        userId: 11,
        offsets: edges(-20),
        rightsAffirmed: false,
      } as never)
    ).rejects.toThrow(/confirm you have the rights/);
  });
});

describe('editing the fit of an existing frame', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindUnique.mockResolvedValue(frame());
    mocks.shopItemUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 42,
      ...data,
    }));
  });

  it('refuses a creator moving an edge past 20, and writes nothing', async () => {
    await expect(
      updateCreatorShopItem({ id: 42, userId: 11, offsets: { ...edges(0), top: -30 } })
    ).rejects.toThrow(OFFSETS_MESSAGE);
    expect(mocks.cosmeticUpdate).not.toHaveBeenCalled();
    expect(mocks.shopItemUpdate).not.toHaveBeenCalled();
  });

  it('accepts a creator at exactly -20 and stores it as given', async () => {
    await updateCreatorShopItem({ id: 42, userId: 11, offsets: edges(-20) });
    expect(writtenOffsets()).toEqual(edges(-20));
  });

  it('accepts a moderator at -50 and stores it as given', async () => {
    await updateCreatorShopItem({
      id: 42,
      userId: 500,
      isModerator: true,
      offsets: edges(-50),
    });
    expect(writtenOffsets()).toEqual(edges(-50));
  });

  it('keeps a moderator-set fit when the creator edits only the name', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(frame(MOD_SET));
    await updateCreatorShopItem({ id: 42, userId: 11, name: 'Golden Frame II' });

    expect(mocks.cosmeticUpdate).toHaveBeenCalledTimes(1);
    // No `data` in the write means the stored blob, offsets included, is left exactly as it was.
    expect(mocks.cosmeticUpdate.mock.calls[0][0].data).toEqual({ name: 'Golden Frame II' });
  });

  it('lets a creator send a moderator-set edge back unchanged while moving another', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(frame(MOD_SET));
    await updateCreatorShopItem({ id: 42, userId: 11, offsets: { ...MOD_SET, top: -10 } });
    expect(writtenOffsets()).toEqual({ ...MOD_SET, top: -10 });
  });

  it('still refuses a creator moving a moderator-set edge to another value past 20', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(frame(MOD_SET));
    await expect(
      updateCreatorShopItem({ id: 42, userId: 11, offsets: { ...MOD_SET, top: -45 } })
    ).rejects.toThrow(OFFSETS_MESSAGE);
    expect(mocks.cosmeticUpdate).not.toHaveBeenCalled();
  });
});
