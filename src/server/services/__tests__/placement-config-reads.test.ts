import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SubscriptionsService from '~/server/services/subscriptions.service';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * How many times one call reads the `placement:config` row.
 *
 * `placement.service` and `placement-space.service` are real here, which is the
 * point: the suites beside this one replace one or the other, so none of them
 * can see a read that crosses the seam between the two.
 */
const configRead = dbMock.dbRead.keyValue.findUnique;

vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionsService>()),
  getCapTier: async () => null,
}));

// Stubbed rather than spread, as in remix-gallery.service.test.ts: each pulls
// the buzz service and its import graph, and nothing here reaches them.
vi.mock('~/server/services/placement-escrow.service', () => ({
  holdPlacementEscrow: vi.fn(),
  settlePlacement: vi.fn(),
  FEE_WAIVING_ACTIONS: [],
}));
vi.mock('~/server/services/placement-moderation.service', () => ({ assertCanPlace: vi.fn() }));
vi.mock('~/server/rewards/active/remixAccept.reward', () => ({
  remixAcceptReward: { apply: vi.fn() },
}));
vi.mock('~/server/services/free-placement.service', () => ({
  createFreePlacement: vi.fn(),
  getFreePlacementAllowance: vi.fn(),
  hasUsedFreePlacementOn: vi.fn(),
}));

const { getPlacementConfig, placementPriceRange } = await import(
  '~/server/services/placement.service'
);
const { resolvePlacementSpaceFor } = await import('~/server/services/placement-space.service');
const { getRemixGalleryVisibility } = await import('~/server/services/remix-gallery.service');

const OWNER = 41;
const HOST_IMAGE = 74;

/** Every value off its compiled default, so a fallback cannot pass as the stored row. */
const STORED = {
  declineFeeRates: { remixGallery: 0.2 },
  approvalShares: { remixGallery: { seller: 0, platform: 0.1 } },
  priceCapTiers: [{ minScore: 0, caps: { free: 300, bronze: 301, silver: 302, gold: 303 } }],
  freeSlotTiers: [{ minScore: 0, caps: { free: 3, bronze: 4, silver: 5, gold: 6 } }],
};

const target = {
  surface: 'remixGallery' as const,
  targetType: 'image' as const,
  targetId: HOST_IMAGE,
};

beforeEach(() => {
  vi.clearAllMocks();
  configRead.mockResolvedValue({ value: STORED });
  dbMock.dbWrite.image.findUnique.mockResolvedValue({
    id: HOST_IMAGE,
    userId: OWNER,
    postId: null,
    user: { username: 'host-owner' },
  });
  // Priced above the cap and offering more free slots than the cap, so both
  // config-derived ceilings are what the result shows.
  dbMock.dbWrite.placementSpace.findMany.mockResolvedValue([
    { entityType: 'user', mode: 'review', price: 450, freeSlots: 5, settings: {} },
  ]);
  dbMock.dbRead.placement.count.mockResolvedValue(1);
  dbMock.dbRead.user.findUnique.mockResolvedValue({ username: 'host-owner' });
  // One row answering every raw read on these paths: the creator score, the
  // has-entries probe and the host image.
  dbMock.dbRead.$queryRaw.mockResolvedValue([
    { score: 0, exists: false, count: 0, nsfwLevel: 1, minor: false, showable: true },
  ]);
});

describe('placement config reads per call', () => {
  it('resolves a space on one read', async () => {
    const space = await resolvePlacementSpaceFor(target);

    // Values first, so a failure on the count below says the answer was
    // already right.
    expect(space).toEqual({
      ownerId: OWNER,
      ownerUsername: 'host-owner',
      mode: 'review',
      setPrice: 450,
      price: 300,
      cap: 300,
      ownerShare: 0.9,
      declineFee: 60,
      declineFeeRate: 0.2,
      hostDeclineFeePercent: null,
      setFreeSlots: 5,
      freeSlots: 3,
      freeSlotCap: 3,
      freeSlotsRemaining: 2,
      settings: {},
    });
    expect(configRead).toHaveBeenCalledTimes(1);
  });

  it('answers the gallery visibility query on one read', async () => {
    const visibility = await getRemixGalleryVisibility({
      hostImageId: HOST_IMAGE,
      browsingLevel: allBrowsingLevelsFlag,
      domainLevels: allBrowsingLevelsFlag,
    });

    expect(visibility).toEqual({
      open: true,
      hasEntries: false,
      render: true,
      price: 300,
      ownerId: OWNER,
      ownerUsername: 'host-owner',
      ownerShare: 0.9,
      freeSlots: 3,
      freeSlotsRemaining: null,
      declineFee: 60,
      pendingCount: 0,
      viewerPending: [],
      maxSubmissionLevel: null,
      acceptedMaxLevel: null,
    });
    expect(configRead).toHaveBeenCalledTimes(1);
  });

  it('quotes no decline fee on an unpriced gallery', async () => {
    dbMock.dbWrite.placementSpace.findMany.mockResolvedValue([
      { entityType: 'user', mode: 'off', price: null, freeSlots: null, settings: {} },
    ]);
    const original = PLACEMENT_SURFACES.remixGallery.defaultPrice;
    (PLACEMENT_SURFACES.remixGallery as { defaultPrice: number | null }).defaultPrice = null;

    try {
      const visibility = await getRemixGalleryVisibility({
        hostImageId: HOST_IMAGE,
        browsingLevel: allBrowsingLevelsFlag,
        domainLevels: allBrowsingLevelsFlag,
      });
      expect(visibility).toMatchObject({ price: null, declineFee: null });
    } finally {
      (PLACEMENT_SURFACES.remixGallery as { defaultPrice: number | null }).defaultPrice = original;
    }
  });
});

describe('placementPriceRange and a supplied config', () => {
  it('reads the config itself when given none', async () => {
    await expect(placementPriceRange(OWNER, 'remixGallery')).resolves.toMatchObject({
      max: 300,
      freeSlotCap: 3,
    });
    expect(configRead).toHaveBeenCalledTimes(1);
  });

  it('prices from the supplied config without a read of its own', async () => {
    const supplied = await getPlacementConfig();
    // The row moves after the caller's read, so a range that read for itself
    // would answer 900 and 9.
    configRead.mockClear();
    configRead.mockResolvedValue({
      value: {
        priceCapTiers: [{ minScore: 0, caps: { free: 900, bronze: 901, silver: 902, gold: 903 } }],
        freeSlotTiers: [{ minScore: 0, caps: { free: 9, bronze: 9, silver: 9, gold: 9 } }],
      },
    });

    await expect(placementPriceRange(OWNER, 'remixGallery', supplied)).resolves.toMatchObject({
      max: 300,
      freeSlotCap: 3,
    });
    expect(configRead).not.toHaveBeenCalled();
  });
});
