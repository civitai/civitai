import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CreatorServiceService from '~/server/services/creator-service.service';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

// A seller who loses the services flag must still pause or remove an Active offering: buyers can
// request it, and the seller can no longer accept. Publishing stays behind both flags.

const { mockSetStatus, mockRemove, mockGetMine, flags } = vi.hoisted(() => ({
  mockSetStatus: vi.fn(),
  mockRemove: vi.fn(),
  mockGetMine: vi.fn(),
  flags: { creatorShop: true, creatorServices: false },
}));

vi.mock('~/server/services/creator-service.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorServiceService>()),
  setServiceOfferingStatus: mockSetStatus,
  removeServiceOffering: mockRemove,
  getMyServiceOfferings: mockGetMine,
}));

// The flag gate reads `getFeatureFlags(ctx)` unless `trpcFlagGuardPerRequest` is on.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ ...flags }),
}));

const { creatorServiceRouter } = await import('~/server/routers/creator-service.router');

const caller = () =>
  creatorServiceRouter.createCaller({
    user: { id: 7, showNsfw: true, browsingLevel: allBrowsingLevelsFlag },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    domain: 'red',
    req: { headers: { host: 'civitai.red' } },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { ...flags, isGreen: false, canViewNsfw: true },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  flags.creatorShop = true;
  flags.creatorServices = false;
  mockGetMine.mockResolvedValue({ items: [], hiddenOffDomain: 0 });
});

describe('creator service router: a seller without the services flag', () => {
  it.each([
    ['creatorServices', { creatorShop: true, creatorServices: false }],
    ['both flags', { creatorShop: false, creatorServices: false }],
  ])('can pause, remove and list their own services without %s', async (_, off) => {
    Object.assign(flags, off);
    await caller().setStatus({ id: 5, status: 'Paused' });
    await caller().remove({ id: 5 });
    await caller().getMine();
    expect(mockSetStatus).toHaveBeenCalledWith({
      sellerId: 7,
      input: { id: 5, status: 'Paused' },
    });
    expect(mockRemove).toHaveBeenCalledWith({ sellerId: 7, id: 5 });
    expect(mockGetMine).toHaveBeenCalledWith(expect.objectContaining({ sellerId: 7 }));
  });

  it.each([
    ['creatorServices', { creatorShop: true, creatorServices: false }],
    ['creatorShop', { creatorShop: false, creatorServices: true }],
  ])('cannot publish without %s', async (_, off) => {
    Object.assign(flags, off);
    await expect(caller().setStatus({ id: 5, status: 'Active' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  // The entries stay behind the flags; only the exits moved.
  it('cannot check eligibility or write a service', async () => {
    await expect(caller().getSellEligibility()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().upsert({} as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('publishes with both flags', async () => {
    flags.creatorServices = true;
    await caller().setStatus({ id: 5, status: 'Active' });
    expect(mockSetStatus).toHaveBeenCalledTimes(1);
  });
});
