import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CreatorServiceService from '~/server/services/creator-service.service';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

// The services filter by what the domain may be sent; only the router knows the domain. A router
// that passed the wrong level would leak mature services to the SFW site with every service test green.

const { mockGetMine, mockGetForShop, mockGetFeed, mockGetById, mockAssertViewable, flags } =
  vi.hoisted(() => ({
    mockAssertViewable: vi.fn(),
    mockGetMine: vi.fn(),
    mockGetForShop: vi.fn(),
    mockGetFeed: vi.fn(),
    mockGetById: vi.fn(),
    flags: { creatorShop: true, creatorServices: true, creatorServicesNext: true },
  }));

vi.mock('~/server/services/creator-service.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorServiceService>()),
  getMyServiceOfferings: mockGetMine,
  getShopServiceOfferings: mockGetForShop,
  getServiceOfferingFeed: mockGetFeed,
  getServiceOfferingById: mockGetById,
  assertServiceOfferingViewable: mockAssertViewable,
}));

// The flag gate reads `getFeatureFlags(ctx)` (Flipt), not `ctx.features`; turned on here so the
// call reaches the procedure. The domain is read from `ctx.features`, as in production.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => flags,
}));

const { creatorServiceRouter } = await import('~/server/routers/creator-service.router');

const callerOn = (green: boolean, viewerLevel: number = allBrowsingLevelsFlag) =>
  creatorServiceRouter.createCaller({
    user: { id: 7, showNsfw: true, browsingLevel: viewerLevel },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    domain: green ? 'green' : 'red',
    req: { headers: { host: green ? 'civitai.com' : 'civitai.red' } },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { creatorShop: true, creatorServices: true, isGreen: green, canViewNsfw: !green },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMine.mockResolvedValue({ items: [], hiddenOffDomain: 0 });
  mockGetForShop.mockResolvedValue([]);
  mockGetFeed.mockResolvedValue({ items: [] });
  mockGetById.mockResolvedValue({});
  flags.creatorServicesNext = true;
});

describe('creator service router: what the domain may be sent', () => {
  it.each([
    ['the SFW site', true, sfwBrowsingLevelsFlag],
    ['civitai.red', false, allBrowsingLevelsFlag],
  ] as const)("a seller's own offerings on %s", async (_, green, servable) => {
    await callerOn(green).getMine();
    expect(mockGetMine).toHaveBeenCalledWith({ sellerId: 7, servable });
  });

  it.each([
    ['the SFW site', true, sfwBrowsingLevelsFlag],
    ['civitai.red', false, allBrowsingLevelsFlag],
  ] as const)('a storefront on %s', async (_, green, servable) => {
    await callerOn(green).getForShop({ userId: 9 });
    expect(mockGetForShop.mock.calls[0][0]).toMatchObject({ userId: 9, viewerId: 7, servable });
  });

  it("fills in a signed-in viewer's own level when the client sends none", async () => {
    await callerOn(false).getForShop({ userId: 9 });
    expect(mockGetForShop.mock.calls[0][0].browsingLevel).toBe(allBrowsingLevelsFlag);
  });

  it("holds a viewer's own level to the SFW site's cap there, however high it is", async () => {
    await callerOn(true).getForShop({ userId: 9 });
    expect(mockGetForShop.mock.calls[0][0].browsingLevel).toBe(sfwBrowsingLevelsFlag);
  });

  // The feed hides the sellers this viewer hid or is blocked with: it has to know who is asking.
  it.each([
    ['the SFW site', true, sfwBrowsingLevelsFlag],
    ['civitai.red', false, allBrowsingLevelsFlag],
  ] as const)('the services feed on %s', async (_, green, level) => {
    await callerOn(green).getFeed({});
    expect(mockGetFeed.mock.calls[0][0]).toMatchObject({
      viewerId: 7,
      servable: level,
      browsingLevel: level,
    });
  });

  // What the domain may serve is not what the viewer browses at: on civitai.red a viewer browsing
  // SFW still gets the full domain mask, so a router that passed one as the other goes red here.
  it.each([
    [
      'a storefront',
      () => mockGetForShop,
      () => callerOn(false, sfwBrowsingLevelsFlag).getForShop({ userId: 9 }),
    ],
    [
      'the services feed',
      () => mockGetFeed,
      () => callerOn(false, sfwBrowsingLevelsFlag).getFeed({}),
    ],
  ] as const)(
    "%s on civitai.red sends the domain's levels, not the viewer's",
    async (_, mock, call) => {
      await call();
      expect(mock().mock.calls[0][0]).toMatchObject({
        servable: allBrowsingLevelsFlag,
        browsingLevel: sfwBrowsingLevelsFlag,
      });
    }
  );
});

describe('creator service router: one service page', () => {
  it.each([
    ['the SFW site', true, sfwBrowsingLevelsFlag],
    ['civitai.red', false, allBrowsingLevelsFlag],
  ] as const)('sends what %s may serve', async (_, green, servable) => {
    await callerOn(green).getById({ id: 3 });
    expect(mockGetById.mock.calls[0][0]).toMatchObject({ id: 3, viewerId: 7, servable });
  });

  it('is refused without the creatorServicesNext flag', async () => {
    flags.creatorServicesNext = false;
    await expect(callerOn(false).getById({ id: 3 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockGetById).not.toHaveBeenCalled();
  });
});

describe("creator service router: an offering's reviews", () => {
  it.each(['getReviews', 'getReviewWork'] as const)(
    '%s answers not found for an offering this viewer may not open, and checks it on this domain',
    async (procedure) => {
      mockAssertViewable.mockRejectedValueOnce(
        new TRPCError({ code: 'NOT_FOUND', message: 'Service not found' })
      );
      await expect(callerOn(true)[procedure]({ id: 3 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(mockAssertViewable.mock.calls[0][0]).toMatchObject({
        id: 3,
        viewerId: 7,
        servable: sfwBrowsingLevelsFlag,
      });
    }
  );

  it.each(['getReviews', 'getReviewWork'] as const)(
    '%s is refused without the creatorServicesNext flag',
    async (procedure) => {
      flags.creatorServicesNext = false;
      await expect(callerOn(false)[procedure]({ id: 3 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(mockAssertViewable).not.toHaveBeenCalled();
    }
  );
});

describe('creator service router: the happy sort', () => {
  it('reads "happy" as newest outside the creatorServicesNext rollout, and keeps it inside', async () => {
    flags.creatorServicesNext = false;
    await callerOn(false).getFeed({ sort: 'happy' });
    expect(mockGetFeed.mock.calls[0][0]).toMatchObject({ sort: 'newest' });
    flags.creatorServicesNext = true;
    await callerOn(false).getFeed({ sort: 'happy' });
    expect(mockGetFeed.mock.calls[1][0]).toMatchObject({ sort: 'happy' });
  });
});
