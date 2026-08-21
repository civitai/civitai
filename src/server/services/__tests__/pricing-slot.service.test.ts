import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

import { MONETIZATION_MIN_CREATOR_SCORE } from '@civitai/buzz';
import {
  assertPricingAllowed,
  countPricingSlotsThisMonth,
  creatorScoreFromMeta,
  recordPricingSlot,
} from '~/server/services/pricing-slot.service';

const mockCount = dbMock.dbRead.pricingSlot.count;
const mockCreateMany = dbMock.dbWrite.pricingSlot.createMany;
const mockFindUnique = dbMock.dbRead.user.findUnique;

beforeEach(() => {
  vi.clearAllMocks();
  mockCount.mockResolvedValue(0 as never);
  mockCreateMany.mockResolvedValue({ count: 1 } as never);
});

describe('creatorScoreFromMeta', () => {
  it('reads the models score', () => {
    expect(creatorScoreFromMeta({ scores: { models: 12345 } })).toBe(12345);
  });

  it('treats missing, null, or non-numeric meta as a score of 0', () => {
    expect(creatorScoreFromMeta(undefined)).toBe(0);
    expect(creatorScoreFromMeta(null)).toBe(0);
    expect(creatorScoreFromMeta({})).toBe(0);
    expect(creatorScoreFromMeta({ scores: {} })).toBe(0);
    expect(creatorScoreFromMeta({ scores: { models: 'lots' } })).toBe(0);
    expect(creatorScoreFromMeta({ scores: { models: Infinity } })).toBe(0);
  });
});

describe('countPricingSlotsThisMonth', () => {
  // afterEach, not a trailing call: a failed assertion would otherwise leak frozen time into every
  // later test in the file and turn one legible failure into a cascade.
  afterEach(() => vi.useRealTimers());

  it('counts from the first of the current UTC month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T13:00:00.000Z'));

    await countPricingSlotsThisMonth(42);

    expect(mockCount).toHaveBeenCalledWith({
      where: { ownerId: 42, createdAt: { gte: new Date('2026-08-01T00:00:00.000Z') } },
    });
  });
});

describe('recordPricingSlot', () => {
  it('inserts with skipDuplicates so a second application costs nothing', async () => {
    await recordPricingSlot({ entityType: 'ModelVersion', entityId: 9, ownerId: 42 });

    expect(mockCreateMany).toHaveBeenCalledWith({
      data: [{ entityType: 'ModelVersion', entityId: 9, ownerId: 42 }],
      skipDuplicates: true,
    });
  });

  // The slot has to join the transaction it accompanies, or a rolled-back write leaves it spent.
  it('writes through a passed transaction client, not the default one', async () => {
    const tx = { pricingSlot: { createMany: vi.fn(async () => ({ count: 1 })) } };

    await recordPricingSlot({ entityType: 'ModelVersion', entityId: 9, ownerId: 42 }, tx as never);

    expect(tx.pricingSlot.createMany).toHaveBeenCalledTimes(1);
    expect(mockCreateMany).not.toHaveBeenCalled();
  });
});

describe('assertPricingAllowed', () => {
  const eligible = { scores: { models: MONETIZATION_MIN_CREATOR_SCORE } };

  it('spends a slot for a newly priced version', async () => {
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        tier: 'free',
        userMeta: eligible,
      })
    ).resolves.toEqual({ spendsSlot: true });
  });

  it('is a no-op when the version was already priced', async () => {
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: true,
        willBePriced: true,
        tier: 'free',
        userMeta: { scores: { models: 0 } },
      })
    ).resolves.toEqual({ spendsSlot: false });
    expect(mockCount).not.toHaveBeenCalled();
  });

  it('is a no-op when the write leaves it unpriced', async () => {
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: false,
        tier: 'free',
        userMeta: { scores: { models: 0 } },
      })
    ).resolves.toEqual({ spendsSlot: false });
  });

  it('refuses one point below the floor and allows exactly the floor', async () => {
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        tier: 'gold',
        userMeta: { scores: { models: MONETIZATION_MIN_CREATOR_SCORE - 1 } },
      })
    ).rejects.toThrow(/creator score/);

    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        tier: 'gold',
        userMeta: eligible,
      })
    ).resolves.toEqual({ spendsSlot: true });
  });

  it('allows the last slot of the month and refuses the next', async () => {
    mockCount.mockResolvedValue(2 as never);
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        tier: 'free',
        userMeta: eligible,
      })
    ).resolves.toEqual({ spendsSlot: true });

    mockCount.mockResolvedValue(3 as never);
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        tier: 'free',
        userMeta: eligible,
      })
    ).rejects.toThrow(/3 of 3/);
  });

  it('gives an unknown or absent tier the free allowance rather than none', async () => {
    mockCount.mockResolvedValue(2 as never);
    await expect(
      assertPricingAllowed({
        userId: 1,
        wasPriced: false,
        willBePriced: true,
        tier: null,
        userMeta: eligible,
      })
    ).resolves.toEqual({ spendsSlot: true });
  });

  it('falls back to reading the score when the caller has no user meta', async () => {
    mockFindUnique.mockResolvedValue({ meta: { scores: { models: 50000 } } } as never);

    await expect(
      assertPricingAllowed({ userId: 1, wasPriced: false, willBePriced: true, tier: 'free' })
    ).resolves.toEqual({ spendsSlot: true });
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 1 }, select: { meta: true } });
  });
});
