import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '~/server/common/enums';

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
  getPlacementConfig: async () => ({ declineFeeRate: () => 0.3 }),
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
  getSponsoredGalleryPost,
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
  settlePlacement.mockResolvedValue({ settled: true });
  isPlacementEscrowFunded.mockResolvedValue(true);
  holdPlacementEscrow.mockResolvedValue({ fee: 63, principal: 147 });

  dbMock.dbWrite.model.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id === HOST_MODEL ? hostModel : where.id === PROMOTED_MODEL ? promotedModel : null
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
  });
});

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

  it('records the images the host accepted and freezes the level and end', async () => {
    await actOnPromotion({ placementId: PLACEMENT, action: 'approve', userId: OWNER });

    expect(dbMock.dbWrite.placement.updateMany).toHaveBeenCalledTimes(1);
    const written = dbMock.dbWrite.placement.updateMany.mock.calls[0][0] as {
      where: unknown;
      data: { data: Record<string, unknown> };
    };
    expect(written.where).toEqual({ id: PLACEMENT, status: 'pending' });
    expect(written.data.data.imageIds).toEqual([11, 12]);
    expect(written.data.data.acceptedLevel).toBe(allBrowsingLevelsFlag);
    expect(typeof written.data.data.endsAt).toBe('string');
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
      spendType: 'green',
    });

  it('holds the daily price for every day of the run', async () => {
    await buy();
    expect(holdPlacementEscrow).toHaveBeenCalledTimes(1);
    expect(holdPlacementEscrow).toHaveBeenCalledWith({
      placementId: PLACEMENT,
      placerId: PLACER,
      surface: 'galleryPromotion',
      amount: DAILY_PRICE * 3,
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

  it('refuses a price that moved while the buyer was deciding', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ownerId: OWNER, mode: 'review', price: 90 });
    await expect(buy()).rejects.toThrow('price changed');
    expect(dbMock.dbWrite.placement.create).not.toHaveBeenCalled();
  });
});

describe('one promotion of a thing per page', () => {
  const buy = () =>
    createModelPromotion({
      placerId: PLACER,
      modelId: HOST_MODEL,
      promotedModelId: PROMOTED_MODEL,
      days: 1,
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

  it('serves only the images and level frozen at accept', async () => {
    const endsAt = new Date(Date.now() + 60_000).toISOString();
    dbMock.dbRead.placement.findMany.mockResolvedValue([live({ acceptedLevel: 3, endsAt })]);
    await expect(
      getSponsoredGalleryPost({ modelId: HOST_MODEL, modelVersionId: HOST_VERSION })
    ).resolves.toEqual({ placementId: PLACEMENT, postId: POST, imageIds: [11], acceptedLevel: 3 });
  });

  it('stops at the frozen end, and in galleries of versions the post did not use', async () => {
    const ended = new Date(Date.now() - 1).toISOString();
    dbMock.dbRead.placement.findMany.mockResolvedValue([live({ acceptedLevel: 3, endsAt: ended })]);
    await expect(
      getSponsoredGalleryPost({ modelId: HOST_MODEL, modelVersionId: HOST_VERSION })
    ).resolves.toBeUndefined();

    dbMock.dbRead.placement.findMany.mockResolvedValue([live({})]);
    await expect(
      getSponsoredGalleryPost({ modelId: HOST_MODEL, modelVersionId: HOST_VERSION + 1 })
    ).resolves.toBeUndefined();
  });
});
