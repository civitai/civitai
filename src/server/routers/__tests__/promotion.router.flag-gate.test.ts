import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromotionService from '~/server/services/promotion.service';
import type * as PlacementSpaceService from '~/server/services/placement-space.service';
import type * as PlacementService from '~/server/services/placement.service';

const { services } = vi.hoisted(() => ({
  services: {
    getPendingPromotions: vi.fn(async () => []),
    getPlacementSpaces: vi.fn(async () => []),
    placementPriceRange: vi.fn(async () => ({ min: 0, max: 0, freeSlotCap: 0 })),
  },
}));

vi.mock('~/server/services/promotion.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PromotionService>()),
  getPendingPromotions: services.getPendingPromotions,
}));
vi.mock('~/server/services/placement-space.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementSpaceService>()),
  getPlacementSpaces: services.getPlacementSpaces,
}));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRange: services.placementPriceRange,
}));

import { placementRouter } from '~/server/routers/placement.router';
import { promotionRouter } from '~/server/routers/promotion.router';
import { OnboardingComplete } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OFF = 'not available yet';

function ctxWith(features: Record<string, boolean>) {
  return {
    user: { id: 41, username: 'host', onboarding: OnboardingComplete },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    // Sparse, as at runtime: an absent flag reads `undefined`, never `false`.
    features,
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('creator promotions are closed with the flag absent', () => {
  const promotion = promotionRouter.createCaller(ctxWith({}));
  const placement = placementRouter.createCaller(ctxWith({}));

  it.each([
    [
      'promotion.createGalleryPromotion',
      () => promotion.createGalleryPromotion({ modelId: 1, postId: 2, days: 1 }),
    ],
    [
      'promotion.createModelPromotion',
      () => promotion.createModelPromotion({ modelId: 1, promotedModelId: 2, days: 1 }),
    ],
    ['promotion.act', () => promotion.act({ placementId: 1, action: 'approve' })],
    ['promotion.getHostsForPost', () => promotion.getHostsForPost({ postId: 2 })],
    ['promotion.getModelOffer', () => promotion.getModelOffer({ modelId: 1 })],
    ['promotion.getPending', () => promotion.getPending({ surface: 'galleryPromotion' })],
    ['promotion.getMine', () => promotion.getMine({ surface: 'modelPromotion' })],
    ['placement.getMySpaces', () => placement.getMySpaces({ surface: 'galleryPromotion' })],
    ['placement.getPriceRange', () => placement.getPriceRange({ surface: 'modelPromotion' })],
  ])('%s refuses', async (_name, call) => {
    await expect(call()).rejects.toThrow(OFF);
  });

  it('reaches no promotion service', async () => {
    await promotion.getPending({ surface: 'galleryPromotion' }).catch(() => undefined);
    await placement.getMySpaces({ surface: 'galleryPromotion' }).catch(() => undefined);
    expect(services.getPendingPromotions).not.toHaveBeenCalled();
    expect(services.getPlacementSpaces).not.toHaveBeenCalled();
  });

  // The shared space endpoints stay open for the surfaces that are not promotions.
  it('leaves the sticker space readable', async () => {
    await expect(placement.getMySpaces({ surface: 'sticker' })).resolves.toEqual([]);
  });
});

describe('the same calls with the flag on', () => {
  const on = ctxWith({ creatorPromotions: true });

  it('reach their service', async () => {
    await promotionRouter.createCaller(on).getPending({ surface: 'galleryPromotion' });
    await placementRouter.createCaller(on).getMySpaces({ surface: 'galleryPromotion' });
    expect(services.getPendingPromotions).toHaveBeenCalledTimes(1);
    expect(services.getPlacementSpaces).toHaveBeenCalledTimes(1);
  });
});
