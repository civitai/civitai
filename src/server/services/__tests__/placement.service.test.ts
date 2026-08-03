import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SubscriptionsService from '~/server/services/subscriptions.service';
import {
  MAX_DECLINE_FEE_RATE,
  MIN_DECLINE_FEE_RATE,
  MIN_OWNER_SHARE,
  PLACEMENT_PRICE_CAP_TIERS,
  PLACEMENT_SURFACES,
  placementSurfaces,
} from '~/shared/utils/placement';

const findUnique = vi.fn();
const queryRaw = vi.fn();
const getCapTier = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: { keyValue: { findUnique }, $queryRaw: queryRaw },
}));

vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionsService>()),
  getCapTier,
}));

const { getPlacementConfig, placementPriceRange, MIN_EXPIRY_HOURS, MAX_EXPIRY_HOURS } =
  await import('~/server/services/placement.service');

const storedConfig = (value: unknown) => findUnique.mockResolvedValue({ value });

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
  queryRaw.mockResolvedValue([{ score: 0 }]);
  getCapTier.mockResolvedValue(null);
});

describe('getPlacementConfig', () => {
  it('clamps every operator-settable value, not just the decline rate', async () => {
    storedConfig({
      declineFeeRates: { sticker: 0, remixGallery: 1 },
      expiryHours: { sticker: 8760, remixGallery: 0.001 },
    });
    const config = await getPlacementConfig();

    expect(config.declineFeeRate('sticker')).toBe(MIN_DECLINE_FEE_RATE);
    expect(config.declineFeeRate('remixGallery')).toBe(MAX_DECLINE_FEE_RATE);
    // Escrow with no timeout is money frozen indefinitely — a year-long expiry
    // defeats the reason expiry exists.
    expect(config.expiryHours('sticker')).toBe(MAX_EXPIRY_HOURS);
    expect(config.expiryHours('remixGallery')).toBe(MIN_EXPIRY_HOURS);
  });

  it('never emits a decline rate outside the enforced bounds, whatever is stored', async () => {
    for (const rate of [-5, 0, 0.0001, 0.3, 0.9, 1, 1000, Number.NaN]) {
      storedConfig({
        declineFeeRates: Object.fromEntries(placementSurfaces.map((s) => [s, rate])),
      });
      const config = await getPlacementConfig();

      for (const surface of placementSurfaces) {
        const emitted = config.declineFeeRate(surface);
        expect(emitted).toBeGreaterThanOrEqual(MIN_DECLINE_FEE_RATE);
        expect(emitted).toBeLessThanOrEqual(MAX_DECLINE_FEE_RATE);
      }
    }
  });

  it('rejects a cap table with no band at zero, which would price every new creator at 0', async () => {
    storedConfig({
      priceCapTiers: [
        { minScore: 5_000, caps: { free: 900, bronze: 900, silver: 900, gold: 900 } },
      ],
    });
    const config = await getPlacementConfig();

    expect(config.priceCapTiers('sticker')[0].minScore).toBe(0);
  });

  it('falls back to compiled defaults when the row is missing or malformed', async () => {
    for (const value of [null, { declineFeeRates: 'thirty percent' }, 42]) {
      findUnique.mockResolvedValue(value === null ? null : { value });
      const config = await getPlacementConfig();
      expect(config.declineFeeRate('sticker')).toBe(
        PLACEMENT_SURFACES.sticker.defaultDeclineFeeRate
      );
      expect(config.expiryHours('sticker')).toBe(PLACEMENT_SURFACES.sticker.expiryHours);
    }
  });

  // Shares that sum to 1 conserve perfectly and pay the space owner nothing,
  // which passes every conservation test and defeats the premise of the feature.
  it('never lets the approval shares squeeze the space owner below their floor', async () => {
    const defaults = {
      seller: PLACEMENT_SURFACES.sticker.defaultSellerShare,
      platform: PLACEMENT_SURFACES.sticker.defaultPlatformShare,
    };

    for (const shares of [
      { seller: 1, platform: 0 },
      { seller: 0, platform: 1 },
      { seller: 0.5, platform: 0.5 },
      { seller: 0.4, platform: 0.3 },
      { seller: -1, platform: 2 },
    ]) {
      storedConfig({ approvalShares: { sticker: shares } });
      const emitted = (await getPlacementConfig()).approvalShares('sticker');

      expect(emitted.seller + emitted.platform).toBeLessThanOrEqual(1 - MIN_OWNER_SHARE);
      expect(emitted).toEqual(defaults);
    }
  });

  it('accepts operator shares that leave the owner their floor', async () => {
    storedConfig({ approvalShares: { sticker: { seller: 0.2, platform: 0.3 } } });
    expect((await getPlacementConfig()).approvalShares('sticker')).toEqual({
      seller: 0.2,
      platform: 0.3,
    });
  });

  it('refuses a fractional price cap, which would produce a non-integer amount', async () => {
    storedConfig({
      priceCapTiers: [{ minScore: 0, caps: { free: 50.5, bronze: 1, silver: 1, gold: 1 } }],
    });
    const config = await getPlacementConfig();

    expect(config.priceCapTiers('sticker')).toBe(PLACEMENT_PRICE_CAP_TIERS);
  });

  it('survives the config read throwing', async () => {
    findUnique.mockRejectedValue(new Error('KeyValue unavailable'));
    const config = await getPlacementConfig();
    expect(config.declineFeeRate('sticker')).toBe(PLACEMENT_SURFACES.sticker.defaultDeclineFeeRate);
  });
});

describe('placementPriceRange', () => {
  // A subscription mid-failed-payment must not buy a higher cap than the UI
  // shows. `getCapTier` is the helper that excludes bad-state subs; using
  // `getHighestTierSubscription` here would hand a lapsed gold member gold caps.
  it('resolves the tier through the cap helper, not the raw subscription', async () => {
    getCapTier.mockResolvedValue(null);
    queryRaw.mockResolvedValue([{ score: 100_000 }]);

    const range = await placementPriceRange(1, 'sticker');

    expect(getCapTier).toHaveBeenCalledWith(1);
    expect(range.tier).toBe('free');
    expect(range.max).toBe(1_000);
  });

  it('caps by score band and tier together', async () => {
    getCapTier.mockResolvedValue('gold');
    queryRaw.mockResolvedValue([{ score: 100_000 }]);

    await expect(placementPriceRange(1, 'sticker')).resolves.toMatchObject({
      tier: 'gold',
      max: 5_000,
    });
  });

  it('treats an unknown tier string as free rather than guessing upward', async () => {
    getCapTier.mockResolvedValue('platinum');
    const range = await placementPriceRange(1, 'sticker');
    expect(range.tier).toBe('free');
  });

  it('treats a user with no stored score as the bottom band', async () => {
    queryRaw.mockResolvedValue([]);
    const range = await placementPriceRange(1, 'sticker');
    expect(range.score).toBe(0);
    expect(range.max).toBe(100);
  });
});
