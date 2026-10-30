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

type Callers = {
  promotion: ReturnType<typeof promotionRouter.createCaller>;
  placement: ReturnType<typeof placementRouter.createCaller>;
};
const callersFor = (features: Record<string, boolean>): Callers => ({
  promotion: promotionRouter.createCaller(ctxWith(features)),
  placement: placementRouter.createCaller(ctxWith(features)),
});

/** Every promotion procedure, and the promotion surfaces of the shared space endpoints. */
const GATED: [string, (c: Callers) => Promise<unknown>][] = [
  [
    'promotion.createGalleryPromotion',
    ({ promotion }) => promotion.createGalleryPromotion({ modelId: 1, postId: 2, days: 1 }),
  ],
  [
    'promotion.createModelPromotion',
    ({ promotion }) => promotion.createModelPromotion({ modelId: 1, promotedModelId: 2, days: 1 }),
  ],
  ['promotion.act', ({ promotion }) => promotion.act({ placementId: 1, action: 'approve' })],
  ['promotion.getHostsForPost', ({ promotion }) => promotion.getHostsForPost({ postId: 2 })],
  ['promotion.getModelOffer', ({ promotion }) => promotion.getModelOffer({ modelId: 1 })],
  [
    'promotion.getPending',
    ({ promotion }) => promotion.getPending({ surface: 'galleryPromotion' }),
  ],
  ['promotion.getMine', ({ promotion }) => promotion.getMine({ surface: 'modelPromotion' })],
  [
    'placement.getMySpaces',
    ({ placement }) => placement.getMySpaces({ surface: 'galleryPromotion' }),
  ],
  [
    'placement.getPriceRange',
    ({ placement }) => placement.getPriceRange({ surface: 'modelPromotion' }),
  ],
  [
    'placement.getSpace',
    ({ placement }) =>
      placement.getSpace({ surface: 'galleryPromotion', targetType: 'model', targetId: 1 }),
  ],
  [
    'placement.getSpaceRow',
    ({ placement }) =>
      placement.getSpaceRow({ surface: 'modelPromotion', entityType: 'user', entityId: 41 }),
  ],
  [
    'placement.getFreeStanding',
    ({ placement }) =>
      placement.getFreeStanding({ surface: 'galleryPromotion', targetType: 'model', targetId: 1 }),
  ],
  [
    'placement.clearSpace',
    ({ placement }) =>
      placement.clearSpace({ surface: 'galleryPromotion', entityType: 'user', entityId: 41 }),
  ],
  [
    'placement.setSpace',
    ({ placement }) =>
      placement.setSpace({
        surface: 'modelPromotion',
        entityType: 'user',
        entityId: 41,
        mode: 'review',
        price: 100,
      }),
  ],
];

describe('creator promotions are closed with the flag absent', () => {
  const off = callersFor({});

  it.each(GATED)('%s refuses', async (_name, call) => {
    await expect(call(off)).rejects.toThrow(OFF);
  });

  it('reaches no promotion service', async () => {
    await off.promotion.getPending({ surface: 'galleryPromotion' }).catch(() => undefined);
    await off.placement.getMySpaces({ surface: 'galleryPromotion' }).catch(() => undefined);
    expect(services.getPendingPromotions).not.toHaveBeenCalled();
    expect(services.getPlacementSpaces).not.toHaveBeenCalled();
  });

  // GATED is written by hand, so this is what makes a new promotion procedure
  // show up here: it fails until the procedure is in the table above.
  it('lists every promotion procedure', () => {
    const listed = GATED.map(([name]) => name)
      .filter((name) => name.startsWith('promotion.'))
      .map((name) => name.slice('promotion.'.length))
      .sort();
    expect(Object.keys(promotionRouter._def.procedures).sort()).toEqual(listed);
  });

  // The shared space endpoints stay open for the surfaces that are not promotions.
  it('leaves the sticker space readable', async () => {
    await expect(off.placement.getMySpaces({ surface: 'sticker' })).resolves.toEqual([]);
  });
});

describe('the same calls with the flag on', () => {
  const on = callersFor({ creatorPromotions: true });

  // They may still fail further in, against an empty test database; what they
  // must not do is fail at the gate. The flag-off row for the same call is what
  // shows this negative assertion is reached at all, so keep the two together.
  it.each(GATED)('%s passes the gate', async (_name, call) => {
    const outcome = await call(on).then(
      () => undefined,
      (error: Error) => error.message
    );
    expect(outcome ?? '').not.toContain(OFF);
  });

  it('reach their service', async () => {
    await on.promotion.getPending({ surface: 'galleryPromotion' });
    await on.placement.getMySpaces({ surface: 'galleryPromotion' });
    expect(services.getPendingPromotions).toHaveBeenCalledTimes(1);
    expect(services.getPlacementSpaces).toHaveBeenCalledTimes(1);
  });
});
