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

const { mockGetMine, mockGetForShop } = vi.hoisted(() => ({
  mockGetMine: vi.fn(),
  mockGetForShop: vi.fn(),
}));

vi.mock('~/server/services/creator-service.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorServiceService>()),
  getMyServiceOfferings: mockGetMine,
  getShopServiceOfferings: mockGetForShop,
}));

// The flag gate reads `getFeatureFlags(ctx)` (Flipt), not `ctx.features`; turned on here so the
// call reaches the procedure. The domain is read from `ctx.features`, as in production.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ creatorShop: true, creatorServices: true }),
}));

const { creatorServiceRouter } = await import('~/server/routers/creator-service.router');

const callerOn = (green: boolean) =>
  creatorServiceRouter.createCaller({
    user: { id: 7, showNsfw: true, browsingLevel: allBrowsingLevelsFlag },
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
});
