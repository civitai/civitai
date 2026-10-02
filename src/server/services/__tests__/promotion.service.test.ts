import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '~/server/common/enums';
import { placementSpaceSchema } from '~/server/schema/placement.schema';
import {
  createGalleryPromotionSchema,
  createModelPromotionSchema,
} from '~/server/schema/promotion.schema';

/** Every quantity distinct, so a value reaching the wrong place cannot pass by colliding. */
const OWNER = 41;
const PLACER = 52;
const STRANGER = 63;
const HOST_MODEL = 74;
const PROMOTED_MODEL = 85;
const PLACEMENT = 96;
const POST = 107;
const HOST_VERSION = 118;
const DAILY_PRICE = 70;

const holdPlacementEscrow = vi.fn();
const settlePlacement = vi.fn();
const isPlacementEscrowFunded = vi.fn();
// Stubbed rather than spread: the real module loads the buzz service graph, which
// is what this file mocks the escrow to keep out. Same as the remix gallery suite.
vi.mock('~/server/services/placement-escrow.service', () => ({
  holdPlacementEscrow,
  settlePlacement,
  isPlacementEscrowFunded,
}));

const assertCanPlace = vi.fn(async () => undefined);
vi.mock('~/server/services/placement-moderation.service', () => ({ assertCanPlace }));

const resolvePlacementSpaceFor = vi.fn();
vi.mock('~/server/services/placement-space.service', () => ({ resolvePlacementSpaceFor }));

vi.mock('~/server/services/placement.service', () => ({
  // The real accessor refuses promotion surfaces; a quote that asked it would
  // be reading a second, different rate.
  getPlacementConfig: async () => ({
    declineFeeRate: () => {
      throw new Error('promotion asked the operator config for its decline rate');
    },
  }),
}));

vi.mock('~/server/services/creator-gallery-hidden-users.service', () => ({
  getCreatorGalleryHiddenUserIds: async () => [],
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  tagIdsForImagesCache: { fetch: async () => ({}) },
}));

const {
  actOnPromotion,
  createGalleryPromotion,
  createModelPromotion,
  getModelPromotionOffer,
  getSponsoredGalleryPost,
  getSponsoredModel,
  hostPromotionLevel,
} = await import('~/server/services/promotion.service');

const hostModel = {
  id: HOST_MODEL,
  userId: OWNER,
  nsfwLevel: NsfwLevel.PG,
  poi: false,
  minor: false,
  sfwOnly: false,
  status: 'Published',
  mode: null,
  availability: 'Public',
  deletedAt: null,
  gallerySettings: null,
};
const promotedModel = { ...hostModel, id: PROMOTED_MODEL, userId: PLACER };
/** The host page as it is now; a case changes it to break exactly one thing. */
let hostRow: typeof hostModel & Record<string, unknown> = { ...hostModel };
/** A host that capped its gallery at PG and R, so a default level cannot pass for it. */
const CAPPED = NsfwLevel.PG | NsfwLevel.R;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The viewer's flags. Sparse, as at runtime, so `{}` is the flag absent. */
const ON = { creatorPromotions: true };

const cleanImage = (id: number) => ({
  id,
  nsfwLevel: NsfwLevel.PG,
  ingestion: 'Scanned',
  nsfwLevelLocked: false,
  needsReview: null,
  minor: false,
  acceptableMinor: false,
  poi: false,
  tosViolation: false,
});

/** The post as it is when the host reviews it: image 12 was added after purchase. */
let postImages = [cleanImage(11), cleanImage(12)];

const pendingGallery = {
  id: PLACEMENT,
  surface: 'galleryPromotion',
  targetId: HOST_MODEL,
  ownerId: OWNER,
  placerId: PLACER,
  status: 'pending',
  amount: DAILY_PRICE * 3,
  data: { postId: POST, days: 3, modelVersionIds: [HOST_VERSION], imageIds: [11] },
};

beforeEach(() => {
  vi.clearAllMocks();
  postImages = [cleanImage(11), cleanImage(12)];
  hostRow = { ...hostModel };
  dbMock.dbRead.model.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id === HOST_MODEL ? hostRow : where.id === PROMOTED_MODEL ? promotedModel : null
  );
  settlePlacement.mockResolvedValue({ settled: true });
  isPlacementEscrowFunded.mockResolvedValue(true);
  holdPlacementEscrow.mockResolvedValue({ fee: 63, principal: 147 });

  dbMock.dbWrite.model.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id === HOST_MODEL ? hostRow : where.id === PROMOTED_MODEL ? promotedModel : null
  );
  dbMock.dbWrite.post.findUnique.mockResolvedValue({
    id: POST,
    userId: PLACER,
    publishedAt: new Date('2026-09-01'),
    tosViolation: false,
  });
  // In call order: the post's images, then which host versions made them.
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join('').includes('ImageResourceNew') ? [{ modelVersionId: HOST_VERSION }] : postImages
  );
  dbMock.dbWrite.placement.findUnique.mockResolvedValue(pendingGallery);
  dbMock.dbWrite.placement.updateMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.placement.findMany.mockResolvedValue([]);
  dbMock.dbWrite.placement.count.mockResolvedValue(0);
  dbMock.dbWrite.placement.create.mockResolvedValue({ id: PLACEMENT });
  resolvePlacementSpaceFor.mockResolvedValue({
    ownerId: OWNER,
    mode: 'review',
    price: DAILY_PRICE,
    hostDeclineFeePercent: HOST_DECLINE_PERCENT,
    declineFeeRate: HOST_DECLINE_PERCENT / 100,
  });
});

// Not the surface default (0) nor the sticker 30%, so a hold sized by either
// reads as a wrong number rather than passing by coincidence.
const HOST_DECLINE_PERCENT = 20;

describe('actOnPromotion', () => {
  it('refuses anyone but the page owner, and moves no money', async () => {
    await expect(
      actOnPromotion({ placementId: PLACEMENT, action: 'approve', userId: STRANGER })
    ).rejects.toThrow('not on your page');
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it('refuses a promotion that is no longer pending', async () => {
    dbMock.dbWrite.placement.findUnique.mockResolvedValue({
      ...pendingGallery,
      status: 'approved',
    });
    await expect(
      actOnPromotion({ placementId: PLACEMENT, action: 'decline', userId: OWNER })
    ).rejects.toThrow('already approved');
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  // The row is visible before its hold lands. Paying the host then would pay
  // out of an escrow that holds nothing.
  it('refuses to accept before the buyer’s escrow is receipted', async () => {
    isPlacementEscrowFunded.mockResolvedValue(false);
    await expect(
      actOnPromotion({ placementId: PLACEMENT, action: 'approve', userId: OWNER })
    ).rejects.toThrow('still processing');
    expect(isPlacementEscrowFunded).toHaveBeenCalledWith({
      placementId: PLACEMENT,
      amount: DAILY_PRICE * 3,
    });
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  describe('with a fixed clock', () => {
    const NOW = new Date('2026-10-01T12:00:00.000Z');
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it('freezes the host model cap and the run end, for a model promotion too', async () => {
      hostRow = { ...hostModel, gallerySettings: { level: CAPPED } };
      dbMock.dbWrite.placement.findUnique.mockResolvedValue({
        ...pendingGallery,
        surface: 'modelPromotion',
        amount: DAILY_PRICE,
        data: { modelId: PROMOTED_MODEL, days: 1 },
      });
      await actOnPromotion({ placementId: PLACEMENT, action: 'approve', userId: OWNER });

      expect(dbMock.dbWrite.placement.updateMany).toHaveBeenCalledWith({
        where: { id: PLACEMENT, status: 'pending' },
        data: {
          data: {
            modelId: PROMOTED_MODEL,
            days: 1,
            acceptedLevel: CAPPED,
            endsAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
          },
        },
      });
    });
  });

  it('refuses to accept a model promotion whose model is now rated above the page', async () => {
    hostRow = { ...hostModel, gallerySettings: { level: NsfwLevel.PG } };
    dbMock.dbWrite.placement.findUnique.mockResolvedValue({
      ...pendingGallery,
      surface: 'modelPromotion',
      amount: DAILY_PRICE,
      data: { modelId: PROMOTED_MODEL, days: 1 },
    });
    dbMock.dbWrite.model.findUnique.mockImplementation(
      async ({ where }: { where: { id: number } }) =>
        where.id === HOST_MODEL ? hostRow : { ...promotedModel, nsfwLevel: NsfwLevel.R }
    );
    await expect(
      actOnPromotion({ placementId: PLACEMENT, action: 'approve', userId: OWNER })
    ).rejects.toThrow('rated above');
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it('records the images the host accepted', async () => {
    await actOnPromotion({ placementId: PLACEMENT, action: 'approve', userId: OWNER });

    expect(dbMock.dbWrite.placement.updateMany).toHaveBeenCalledTimes(1);
    const written = dbMock.dbWrite.placement.updateMany.mock.calls[0][0] as {
      data: { data: Record<string, unknown> };
    };
    expect(written.data.data.imageIds).toEqual([11, 12]);
    expect(settlePlacement).toHaveBeenCalledTimes(1);
    expect(settlePlacement).toHaveBeenCalledWith({
      placementId: PLACEMENT,
      action: 'approve',
      actorId: OWNER,
    });
  });

  it('re-checks the post at accept, refusing one that changed since purchase', async () => {
    postImages = [cleanImage(11), { ...cleanImage(12), acceptableMinor: true }];
    await expect(
      actOnPromotion({ placementId: PLACEMENT, action: 'approve', userId: OWNER })
    ).rejects.toThrow('cannot be promoted');
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it('declines without re-checking the post or the escrow', async () => {
    postImages = [{ ...cleanImage(11), minor: true }];
    await actOnPromotion({ placementId: PLACEMENT, action: 'decline', userId: OWNER });
    expect(isPlacementEscrowFunded).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.placement.updateMany).not.toHaveBeenCalled();
    expect(settlePlacement).toHaveBeenCalledTimes(1);
    expect(settlePlacement).toHaveBeenCalledWith({
      placementId: PLACEMENT,
      action: 'decline',
      actorId: OWNER,
    });
  });
});

describe('createGalleryPromotion', () => {
  const buy = () =>
    createGalleryPromotion({
      placerId: PLACER,
      modelId: HOST_MODEL,
      postId: POST,
      days: 3,
      expectedPrice: DAILY_PRICE,
      expectedDeclineFeePercent: HOST_DECLINE_PERCENT,
      spendType: 'green',
    });

  it('writes the post, the host versions it used and its images', async () => {
    await buy();
    expect(dbMock.dbWrite.placement.create).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.placement.create.mock.calls[0][0]).toMatchObject({
      data: {
        surface: 'galleryPromotion',
        targetType: 'model',
        targetId: HOST_MODEL,
        ownerId: OWNER,
        placerId: PLACER,
        amount: DAILY_PRICE * 3,
        status: 'pending',
        data: { postId: POST, days: 3, modelVersionIds: [HOST_VERSION], imageIds: [11, 12] },
      },
    });
  });

  it.each([
    ['unreviewed', { ingestion: 'Pending' }],
    ['held for review', { needsReview: 'poi' }],
    ['flagged minor', { minor: true }],
    ['marked an acceptable minor', { acceptableMinor: true }],
    ['a real person', { poi: true }],
    ['a ToS violation', { tosViolation: true }],
    [
      'an errored scan only Knights rated',
      { ingestion: 'Error', nsfwLevelLocked: true, nsfwLevelReason: 'Knights Vote' },
    ],
  ])('refuses a post with an image that is %s', async (_label, change) => {
    postImages = [cleanImage(11), { ...cleanImage(12), ...change }];
    await expect(buy()).rejects.toThrow('cannot be promoted');
    expect(dbMock.dbWrite.placement.create).not.toHaveBeenCalled();
  });

  it('accepts a stalled scan a moderator rated, as the rest of the site does', async () => {
    postImages = [{ ...cleanImage(11), ingestion: 'Pending', nsfwLevelLocked: true }];
    await expect(buy()).resolves.toEqual({ id: PLACEMENT });
  });

  it('holds the daily price for every day of the run', async () => {
    await buy();
    expect(holdPlacementEscrow).toHaveBeenCalledTimes(1);
    expect(holdPlacementEscrow).toHaveBeenCalledWith({
      placementId: PLACEMENT,
      placerId: PLACER,
      surface: 'galleryPromotion',
      amount: DAILY_PRICE * 3,
      declineFeeRate: HOST_DECLINE_PERCENT / 100,
      spendType: 'green',
    });
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it('expires the row when the hold fails, and surfaces the hold’s error', async () => {
    holdPlacementEscrow.mockRejectedValue(new Error('insufficient funds'));
    await expect(buy()).rejects.toThrow('insufficient funds');
    expect(settlePlacement).toHaveBeenCalledTimes(1);
    expect(settlePlacement).toHaveBeenCalledWith({ placementId: PLACEMENT, action: 'expire' });
  });

  it('still surfaces the hold’s error when the compensating expire also fails', async () => {
    holdPlacementEscrow.mockRejectedValue(new Error('insufficient funds'));
    settlePlacement.mockRejectedValue(new Error('db down'));
    await expect(buy()).rejects.toThrow('insufficient funds');
  });

  it('looks for the same post on the same page', async () => {
    await buy();
    expect(dbMock.dbWrite.placement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          surface: 'galleryPromotion',
          targetId: HOST_MODEL,
          data: { path: ['postId'], equals: POST },
        }),
      })
    );
  });

  it('refuses a price that moved while the buyer was deciding', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ownerId: OWNER, mode: 'review', price: 90 });
    await expect(buy()).rejects.toThrow('price changed');
    expect(dbMock.dbWrite.placement.create).not.toHaveBeenCalled();
  });

  it('refuses a decline fee that moved while the buyer was deciding', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({
      ownerId: OWNER,
      mode: 'review',
      price: DAILY_PRICE,
      hostDeclineFeePercent: 25,
      declineFeeRate: 0.25,
    });
    await expect(buy()).rejects.toThrow('decline fee changed to 25%');
    expect(dbMock.dbWrite.placement.create).not.toHaveBeenCalled();
    expect(holdPlacementEscrow).not.toHaveBeenCalled();
  });

  // 🔴 Required on purpose, unlike `expectedPrice`. A caller that omits it would
  // be held to a fee it was never shown. Pinned at a 0% host, where an optional
  // check mirrored from the price one (`expected != null && ...`) would let the
  // purchase through.
  it('refuses a purchase that does not say what decline fee it was shown', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({
      ownerId: OWNER,
      mode: 'review',
      price: DAILY_PRICE,
      hostDeclineFeePercent: 0,
      declineFeeRate: 0,
    });
    await expect(
      createGalleryPromotion({
        placerId: PLACER,
        modelId: HOST_MODEL,
        postId: POST,
        days: 3,
        expectedPrice: DAILY_PRICE,
        spendType: 'green',
      } as unknown as Parameters<typeof createGalleryPromotion>[0])
    ).rejects.toThrow('decline fee changed');
    expect(dbMock.dbWrite.placement.create).not.toHaveBeenCalled();
  });
});

describe('the checkout quote', () => {
  const offer = () => getModelPromotionOffer({ modelId: HOST_MODEL, placerId: PLACER });

  it('quotes the host percent and what it keeps for each run length', async () => {
    expect(await offer()).toMatchObject({
      open: true,
      dailyPrice: DAILY_PRICE,
      declineFeePercent: HOST_DECLINE_PERCENT,
      declineFees: { 1: 14, 3: 42, 7: 98 },
    });
  });

  it('quotes nothing kept for a 0% host', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({
      ownerId: OWNER,
      mode: 'review',
      price: DAILY_PRICE,
      hostDeclineFeePercent: 0,
      declineFeeRate: 0,
    });
    expect(await offer()).toMatchObject({
      open: true,
      declineFeePercent: 0,
      declineFees: { 1: 0, 3: 0, 7: 0 },
    });
  });
});

describe('createModelPromotion', () => {
  it('holds at the host rate the buyer was shown', async () => {
    await createModelPromotion({
      placerId: PLACER,
      modelId: HOST_MODEL,
      promotedModelId: PROMOTED_MODEL,
      days: 7,
      expectedPrice: DAILY_PRICE,
      expectedDeclineFeePercent: HOST_DECLINE_PERCENT,
      spendType: 'green',
    });
    expect(holdPlacementEscrow).toHaveBeenCalledTimes(1);
    expect(holdPlacementEscrow).toHaveBeenCalledWith({
      placementId: PLACEMENT,
      placerId: PLACER,
      surface: 'modelPromotion',
      amount: DAILY_PRICE * 7,
      declineFeeRate: HOST_DECLINE_PERCENT / 100,
      spendType: 'green',
    });
  });
});

describe('one promotion of a thing per page', () => {
  const buy = () =>
    createModelPromotion({
      placerId: PLACER,
      modelId: HOST_MODEL,
      promotedModelId: PROMOTED_MODEL,
      days: 1,
      expectedDeclineFeePercent: HOST_DECLINE_PERCENT,
      spendType: 'green',
    });

  // A mocked findMany ignores `where`, so the JSON path filter is not exercised
  // here; this pins what counts as blocking among the rows it returns.
  it('is blocked by a pending one', async () => {
    dbMock.dbWrite.placement.findMany.mockResolvedValue([
      { status: 'pending', resolvedAt: null, data: { modelId: PROMOTED_MODEL, days: 1 } },
    ]);
    await expect(buy()).rejects.toThrow('already promoted');
    expect(dbMock.dbWrite.placement.create).not.toHaveBeenCalled();
  });

  it('looks for the same promoted model on the same page', async () => {
    await buy();
    expect(dbMock.dbWrite.placement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          surface: 'modelPromotion',
          targetType: 'model',
          targetId: HOST_MODEL,
          status: { in: ['pending', 'approved'] },
          data: { path: ['modelId'], equals: PROMOTED_MODEL },
        },
      })
    );
  });

  it('is blocked by a live one and not by one that has ended', async () => {
    dbMock.dbWrite.placement.findMany.mockResolvedValue([
      { status: 'approved', resolvedAt: new Date(), data: { modelId: PROMOTED_MODEL, days: 1 } },
    ]);
    await expect(buy()).rejects.toThrow('already promoted');

    dbMock.dbWrite.placement.findMany.mockResolvedValue([
      {
        status: 'approved',
        resolvedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        data: { modelId: PROMOTED_MODEL, days: 1 },
      },
    ]);
    await expect(buy()).resolves.toEqual({ id: PLACEMENT });
  });
});

describe('hostPromotionLevel', () => {
  it('holds a minor or SFW-only model to PG/PG-13 whatever its gallery allows', () => {
    const gallerySettings = { level: allBrowsingLevelsFlag };
    expect(hostPromotionLevel({ minor: true, sfwOnly: false, gallerySettings })).toBe(
      sfwBrowsingLevelsFlag
    );
    expect(hostPromotionLevel({ minor: false, sfwOnly: true, gallerySettings })).toBe(
      sfwBrowsingLevelsFlag
    );
  });

  it("is the gallery's level cap, or every level when the host set none", () => {
    expect(
      hostPromotionLevel({
        minor: false,
        sfwOnly: false,
        gallerySettings: { level: NsfwLevel.PG | NsfwLevel.R },
      })
    ).toBe(NsfwLevel.PG | NsfwLevel.R);
    expect(hostPromotionLevel({ minor: false, sfwOnly: false, gallerySettings: null })).toBe(
      allBrowsingLevelsFlag
    );
  });
});

describe('getSponsoredGalleryPost', () => {
  const live = (data: Record<string, unknown>) => ({
    id: PLACEMENT,
    placerId: PLACER,
    resolvedAt: new Date(Date.now() - 60_000),
    data: { postId: POST, days: 3, modelVersionIds: [HOST_VERSION], imageIds: [11], ...data },
  });

  const endsAt = () => new Date(Date.now() + 60_000).toISOString();

  it('reads only approved runs on this page', async () => {
    await getSponsoredGalleryPost({
      modelId: HOST_MODEL,
      modelVersionId: HOST_VERSION,
      features: ON,
    });
    expect(dbMock.dbRead.placement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          surface: 'galleryPromotion',
          targetId: HOST_MODEL,
          status: 'approved',
        }),
      })
    );
  });

  it('serves the approved images at the cap frozen at accept', async () => {
    // The host has since lowered their gallery to PG; the run keeps what it was sold.
    hostRow = { ...hostModel, gallerySettings: { level: NsfwLevel.PG } };
    dbMock.dbRead.placement.findMany.mockResolvedValue([
      live({ acceptedLevel: CAPPED, endsAt: endsAt() }),
    ]);
    await expect(
      getSponsoredGalleryPost({ modelId: HOST_MODEL, modelVersionId: HOST_VERSION, features: ON })
    ).resolves.toEqual({
      placementId: PLACEMENT,
      postId: POST,
      imageIds: [11],
      servingLevel: CAPPED,
    });
  });

  it('serves nothing once the host page is gone', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(null);
    dbMock.dbRead.placement.findMany.mockResolvedValue([
      live({ acceptedLevel: CAPPED, endsAt: endsAt() }),
    ]);
    await expect(
      getSponsoredGalleryPost({ modelId: HOST_MODEL, modelVersionId: HOST_VERSION, features: ON })
    ).resolves.toBeUndefined();
  });

  it('still applies the minor lock set after accept', async () => {
    hostRow = { ...hostModel, minor: true };
    dbMock.dbRead.placement.findMany.mockResolvedValue([
      live({ acceptedLevel: allBrowsingLevelsFlag, endsAt: endsAt() }),
    ]);
    const served = await getSponsoredGalleryPost({
      modelId: HOST_MODEL,
      modelVersionId: HOST_VERSION,
      features: ON,
    });
    expect(served?.servingLevel).toBe(sfwBrowsingLevelsFlag);
  });

  it('stops at the frozen end, and in galleries of versions the post did not use', async () => {
    const ended = new Date(Date.now() - 1).toISOString();
    dbMock.dbRead.placement.findMany.mockResolvedValue([live({ acceptedLevel: 3, endsAt: ended })]);
    await expect(
      getSponsoredGalleryPost({ modelId: HOST_MODEL, modelVersionId: HOST_VERSION, features: ON })
    ).resolves.toBeUndefined();

    dbMock.dbRead.placement.findMany.mockResolvedValue([live({})]);
    await expect(
      getSponsoredGalleryPost({
        modelId: HOST_MODEL,
        modelVersionId: HOST_VERSION + 1,
        features: ON,
      })
    ).resolves.toBeUndefined();
  });
});

describe('getSponsoredModel', () => {
  it('serves a live run at the frozen cap and the host page lock as it is now', async () => {
    hostRow = { ...hostModel, sfwOnly: true };
    dbMock.dbRead.placement.findMany.mockResolvedValue([
      {
        id: PLACEMENT,
        placerId: PLACER,
        resolvedAt: new Date(Date.now() - 60_000),
        data: {
          modelId: PROMOTED_MODEL,
          days: 1,
          acceptedLevel: CAPPED,
          endsAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    ]);
    await expect(getSponsoredModel({ modelId: HOST_MODEL, features: ON })).resolves.toEqual({
      placementId: PLACEMENT,
      modelId: PROMOTED_MODEL,
      servingLevel: CAPPED & sfwBrowsingLevelsFlag,
    });
    expect(dbMock.dbRead.placement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ surface: 'modelPromotion', status: 'approved' }),
      })
    );
  });
});

describe('serving with the flag absent', () => {
  it('serves no sponsored post or model, and reads nothing', async () => {
    // Rows each getter would serve with the flag on, so an empty result means the gate.
    const resolvedAt = new Date(Date.now() - 60_000);
    dbMock.dbRead.placement.findMany.mockResolvedValue([
      { id: PLACEMENT, placerId: PLACER, resolvedAt, data: { modelId: PROMOTED_MODEL, days: 1 } },
      {
        id: PLACEMENT,
        placerId: PLACER,
        resolvedAt,
        data: { postId: POST, days: 1, modelVersionIds: [HOST_VERSION], imageIds: [11] },
      },
    ]);
    await expect(
      getSponsoredGalleryPost({ modelId: HOST_MODEL, modelVersionId: HOST_VERSION, features: {} })
    ).resolves.toBeUndefined();
    await expect(getSponsoredModel({ modelId: HOST_MODEL, features: {} })).resolves.toBeUndefined();
    expect(dbMock.dbRead.placement.findMany).not.toHaveBeenCalled();
  });
});

describe('the purchase schemas', () => {
  const gallery = { modelId: 1, postId: 2, days: 3, expectedPrice: 50 };
  const model = { modelId: 1, promotedModelId: 2, days: 3, expectedPrice: 50 };

  it('require the decline fee the buyer was shown', () => {
    expect(createGalleryPromotionSchema.safeParse(gallery).success).toBe(false);
    expect(createModelPromotionSchema.safeParse(model).success).toBe(false);
    expect(
      createGalleryPromotionSchema.safeParse({ ...gallery, expectedDeclineFeePercent: 0 }).success
    ).toBe(true);
    expect(
      createModelPromotionSchema.safeParse({ ...model, expectedDeclineFeePercent: 0 }).success
    ).toBe(true);
  });
});

describe('the space settings schema', () => {
  const space = { entityType: 'user', entityId: 1, mode: 'review' } as const;
  const issues = (input: Record<string, unknown>) => {
    const parsed = placementSpaceSchema.safeParse({ ...space, ...input });
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));
  };

  it('takes a host decline fee on promotions only', () => {
    expect(issues({ surface: 'galleryPromotion', declineFeePercent: 30 })).toEqual([]);
    expect(issues({ surface: 'modelPromotion', declineFeePercent: 0 })).toEqual([]);
    expect(issues({ surface: 'galleryPromotion', declineFeePercent: 31 })).toEqual([
      'declineFeePercent',
    ]);
    expect(issues({ surface: 'sticker', declineFeePercent: 30 })).toEqual(['declineFeePercent']);
    expect(issues({ surface: 'remixGallery', declineFeePercent: 0 })).toEqual([
      'declineFeePercent',
    ]);
  });
});
