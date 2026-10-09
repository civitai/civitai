import { beforeEach, describe, expect, it, vi } from 'vitest';

// Cuts, to keep Prisma and Redis off the load path. The router and its middleware load for real.
const mocks = vi.hoisted(() => ({
  journey: vi.fn(),
  shareable: vi.fn(),
}));
vi.mock('~/server/services/creator-journey.service', () => ({
  getCreatorJourney: (...args: unknown[]) => mocks.journey(...args),
  getCreatorScoreLadder: vi.fn(),
  getFirstPublishCard: vi.fn(),
  getLegendStatus: vi.fn(),
  getProfileAchievements: vi.fn(),
}));
vi.mock('~/server/services/creator-showcase.service', () => ({ getCreatorShowcase: vi.fn() }));
vi.mock('~/server/services/creator-milestone-share.service', () => ({
  getShareableTierSlugs: (...args: unknown[]) => mocks.shareable(...args),
  isMilestoneShareable: vi.fn(),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFeatureFlags: () => ({ creatorJourney: true }),
}));

import { creatorJourneyRouter } from '../creator-journey.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = 42;
const JOURNEY = { scores: null, tiers: [], earned: [{ key: 'score:spark' }] };

const getMine = () =>
  creatorJourneyRouter
    .createCaller({
      user: { id: OWNER },
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      apiKeyId: null,
      req: { headers: {} },
      res: { setHeader: () => undefined },
      cache: { edgeTTL: 0 },
      features: {},
      track: { action: vi.fn(() => Promise.resolve(true)) },
    } as never)
    .getMine();

beforeEach(() => {
  mocks.journey.mockReset().mockResolvedValue(JOURNEY);
  mocks.shareable.mockReset();
});

describe('creatorJourney.getMine', () => {
  it("adds the owner's shareable tiers to the journey", async () => {
    mocks.shareable.mockResolvedValue(['spark']);
    await expect(getMine()).resolves.toEqual({ ...JOURNEY, shareableTiers: ['spark'] });
    expect(mocks.journey).toHaveBeenCalledWith(OWNER);
    expect(mocks.shareable).toHaveBeenCalledWith(OWNER);
  });

  // Share buttons are extras. A failed share read (the metric-exclusion list is fail-closed) must
  // hide them, not take down the whole journey page.
  it('still returns the journey, with no share buttons, when the share read fails', async () => {
    mocks.shareable.mockRejectedValue(new Error('exclusions unavailable'));
    await expect(getMine()).resolves.toEqual({ ...JOURNEY, shareableTiers: [] });
  });
});
