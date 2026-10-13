import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetMyRemovedImages } = vi.hoisted(() => ({ mockGetMyRemovedImages: vi.fn() }));

// Mocked so importing the router does not pull in the services' ClickHouse and db clients.
vi.mock('~/server/services/creator-removed-images.service', () => ({
  getMyRemovedImages: (...args: unknown[]) => mockGetMyRemovedImages(...args),
}));
vi.mock('~/server/services/creator-journey.service', () => ({}));
vi.mock('~/server/services/creator-showcase.service', () => ({}));
vi.mock('~/server/services/creator-milestone-share.service', () => ({}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ creatorJourney: true }),
}));

import { creatorJourneyRouter } from '../creator-journey.router';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function callerFor(user: { id: number } | undefined, tokenScope: number = TokenScope.Full) {
  return creatorJourneyRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

beforeEach(() => {
  mockGetMyRemovedImages.mockReset();
  mockGetMyRemovedImages.mockResolvedValue({ total: 0, truncated: false, items: [] });
});

describe('creatorJourney.getMyRemovedImages', () => {
  it('reads the signed-in caller’s own removals', async () => {
    await callerFor({ id: 7 }).getMyRemovedImages();

    expect(mockGetMyRemovedImages).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('ignores another user’s id sent as input', async () => {
    const getOther = callerFor({ id: 7 }).getMyRemovedImages as unknown as (input: {
      userId: number;
    }) => Promise<unknown>;

    await getOther({ userId: 99 });

    expect(mockGetMyRemovedImages).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('refuses a signed-out caller', async () => {
    await expect(callerFor(undefined).getMyRemovedImages()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockGetMyRemovedImages).not.toHaveBeenCalled();
  });

  it('needs the profile-read scope on a scoped token', async () => {
    await expect(
      callerFor({ id: 7 }, TokenScope.UserRead << 1).getMyRemovedImages()
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await callerFor({ id: 7 }, TokenScope.UserRead).getMyRemovedImages();
    expect(mockGetMyRemovedImages).toHaveBeenCalledExactlyOnceWith(7);
  });
});
