import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CloudflareClient from '~/server/cloudflare/client';
import type * as LoggingClient from '~/server/logging/client';
import {
  DEFAULT_CREATOR_SHOP_FEES,
  creatorCosmeticTypes,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    keyValueFindUnique: vi.fn(),
    executeRawUnsafe: vi.fn(),
    purgeCache: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: {
    keyValue: { findUnique: mocks.keyValueFindUnique },
    $executeRawUnsafe: mocks.executeRawUnsafe,
  },
}));

vi.mock('~/server/cloudflare/client', async (importOriginal) => ({
  ...(await importOriginal<typeof CloudflareClient>()),
  purgeCache: mocks.purgeCache,
}));

vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof LoggingClient>()),
  logToAxiom: vi.fn(),
}));

const { getCreatorShopFees, getCreatorShopSubmissionFee, setCreatorShopFees } = await import(
  '../creator-shop-fees.service'
);

const stored = (value: unknown) => mocks.keyValueFindUnique.mockResolvedValue({ key: 'k', value });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.keyValueFindUnique.mockResolvedValue(null);
  mocks.purgeCache.mockResolvedValue(undefined);
});

describe('getCreatorShopFees', () => {
  // The whole point of the change: one type's fee moves without repricing the rest.
  it('resolves each cosmetic type independently', async () => {
    stored({ submission: { Sticker: 5000, Badge: 12000 } });
    const fees = await getCreatorShopFees();

    expect(fees.submission.Sticker).toBe(5000);
    expect(fees.submission.Badge).toBe(12000);
    expect(fees.submission.ProfileDecoration).toBe(10000);
    expect(fees.submission.ProfileBackground).toBe(10000);
    expect(fees.submission.ContentDecoration).toBe(10000);
  });

  it('serves 10000 for every type and 1000 for packs when the row is absent', async () => {
    const fees = await getCreatorShopFees();

    expect(fees).toEqual(DEFAULT_CREATOR_SHOP_FEES);
    for (const type of creatorCosmeticTypes) expect(fees.submission[type]).toBe(10000);
    expect(fees.pack).toBe(1000);
  });

  // A fee reaches the money path before anything is reviewed, so a junk value must
  // not travel — and it must not take the sibling types down with it either.
  it('falls back per value on a malformed row', async () => {
    for (const value of [
      42,
      'ten thousand',
      { submission: 'all of them' },
      { submission: { Sticker: -1, Badge: 1.5 }, pack: Number.NaN },
      { submission: { Sticker: null }, pack: '1000' },
    ]) {
      stored(value);
      const fees = await getCreatorShopFees();
      expect(fees).toEqual(DEFAULT_CREATOR_SHOP_FEES);
    }
  });

  it('keeps a usable sibling when one type is junk', async () => {
    stored({ submission: { Sticker: 5000, Badge: 'free' } });
    const fees = await getCreatorShopFees();

    expect(fees.submission.Sticker).toBe(5000);
    expect(fees.submission.Badge).toBe(10000);
  });

  // Not the placement-config posture. Quoting a default while the row says something
  // lower would charge more than the submit form showed.
  it('refuses to invent a fee when the row cannot be read', async () => {
    mocks.keyValueFindUnique.mockRejectedValue(new Error('KeyValue unavailable'));
    await expect(getCreatorShopFees()).rejects.toThrow('KeyValue unavailable');
  });
});

describe('getCreatorShopSubmissionFee', () => {
  it('returns the stored fee for the type asked for', async () => {
    stored({ submission: { Sticker: 5000 } });

    await expect(getCreatorShopSubmissionFee(CosmeticType.Sticker)).resolves.toBe(5000);
    await expect(getCreatorShopSubmissionFee(CosmeticType.Badge)).resolves.toBe(10000);
  });
});

describe('setCreatorShopFees', () => {
  it('leaves the types it was not given alone', async () => {
    stored({ submission: { Sticker: 5000, Badge: 12000 }, pack: 2000 });

    const next = await setCreatorShopFees({ submission: { Sticker: 7000 } });

    expect(next.submission.Sticker).toBe(7000);
    expect(next.submission.Badge).toBe(12000);
    expect(next.pack).toBe(2000);
    expect(mocks.executeRawUnsafe).toHaveBeenCalledTimes(1);
  });

  // A stale edge cache is a fee the creator agreed to and did not pay.
  it('busts the edge cache the submit form reads through', async () => {
    await setCreatorShopFees({ pack: 1500 });
    expect(mocks.purgeCache).toHaveBeenCalledWith({ tags: ['creator-shop-fees'] });
  });

  it('does not fail the write when the purge does', async () => {
    mocks.purgeCache.mockRejectedValue(new Error('cloudflare down'));
    await expect(setCreatorShopFees({ pack: 1500 })).resolves.toMatchObject({ pack: 1500 });
  });
});
