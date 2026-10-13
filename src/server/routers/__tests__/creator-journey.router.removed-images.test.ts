import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetMyRemovedImages } = vi.hoisted(() => ({ mockGetMyRemovedImages: vi.fn() }));

// Cuts, to keep the rest of the journey surface off the load path.
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

function callerFor(user: { id: number } | undefined) {
  return creatorJourneyRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
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
  mockGetMyRemovedImages.mockResolvedValue({ total: 0, items: [] });
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
});
