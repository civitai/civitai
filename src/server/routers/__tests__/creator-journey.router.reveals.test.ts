import { beforeEach, describe, expect, it, vi } from 'vitest';

// Cuts, to keep Prisma and Redis off the load path. The router and its middleware load for real.
const mocks = vi.hoisted(() => ({ markSeen: vi.fn() }));
vi.mock('~/server/services/creator-journey.service', () => ({
  getCreatorJourney: vi.fn(),
  getCreatorScoreLadder: vi.fn(),
  getFirstPublishCard: vi.fn(),
  getLegendStatus: vi.fn(),
  getProfileAchievements: vi.fn(),
}));
vi.mock('~/server/services/creator-showcase.service', () => ({ getCreatorShowcase: vi.fn() }));
vi.mock('~/server/services/creator-milestone-share.service', () => ({
  getMilestoneShareStates: vi.fn(),
  isMilestoneShareable: vi.fn(),
}));
vi.mock('~/server/services/creator-milestone-grant.service', () => ({
  markMilestonesSeen: (...args: unknown[]) => mocks.markSeen(...args),
}));
vi.mock('~/server/db/pgDb', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pgDbWrite: 'write-pool',
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFeatureFlags: () => ({ creatorJourney: true }),
}));

import { creatorJourneyRouter } from '../creator-journey.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = 42;

const caller = () =>
  creatorJourneyRouter.createCaller({
    user: { id: OWNER },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);

beforeEach(() => {
  mocks.markSeen.mockReset().mockResolvedValue(undefined);
});

describe('creatorJourney.markRevealsSeen', () => {
  // The input carries keys only; whose rows they are comes from the session, never the request.
  it("marks the keys seen on the viewer's own rows, on the write pool", async () => {
    await caller().markRevealsSeen({ keys: ['score:spark', 'create:models-1'] });
    expect(mocks.markSeen).toHaveBeenCalledWith('write-pool', [
      { userId: OWNER, milestoneKey: 'score:spark' },
      { userId: OWNER, milestoneKey: 'create:models-1' },
    ]);
  });

  it('refuses an empty list', async () => {
    await expect(caller().markRevealsSeen({ keys: [] })).rejects.toThrow();
    expect(mocks.markSeen).not.toHaveBeenCalled();
  });
});
