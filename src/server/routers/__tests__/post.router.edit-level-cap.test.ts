import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as PostPlannerService from '~/server/services/post-planner.service';
import type * as PostService from '~/server/services/post.service';
import {
  browsingLevels,
  parseBitwiseBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The post editor and the planner's post detail take no browsing level from the client, so each
 * procedure must hand the service the request's own cap. Without it a capped request shows the
 * owner's post images at every level.
 */

const { mockEditDetail, mockPlannerDetail } = vi.hoisted(() => ({
  mockEditDetail: vi.fn(),
  mockPlannerDetail: vi.fn(),
}));

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  getPostEditDetail: (...args: unknown[]) => mockEditDetail(...args),
}));
vi.mock('~/server/services/post-planner.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostPlannerService>()),
  getPlannerPostDetail: (...args: unknown[]) => mockPlannerDetail(...args),
}));

const { postRouter } = await import('../post.router');

const OWNER = 10;

function callerFor(canViewNsfw: boolean) {
  return postRouter.createCaller({
    user: { id: OWNER, tier: 'free', username: 'owner', muted: false, onboarding: 0xff },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw, postPlanner: true, trpcFlagGuardPerRequest: true },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

const servedLevels = (mock: ReturnType<typeof vi.fn>) => {
  const [args] = mock.mock.calls[0] as [{ servableLevels: number }];
  return parseBitwiseBrowsingLevel(args.servableLevels);
};

beforeEach(() => {
  mockEditDetail.mockReset().mockResolvedValue({});
  mockPlannerDetail.mockReset().mockResolvedValue({});
});

describe.each([
  [
    'post.getEdit',
    (canViewNsfw: boolean) => callerFor(canViewNsfw).getEdit({ id: 1 }),
    mockEditDetail,
  ],
  [
    'post.getPlannerDetail',
    (canViewNsfw: boolean) => callerFor(canViewNsfw).getPlannerDetail({ id: 1 }),
    mockPlannerDetail,
  ],
] as const)('%s request cap', (_name, call, mock) => {
  it('a capped request (no NSFW on this domain) hands the service PG and PG13 only', async () => {
    await call(false);
    expect(servedLevels(mock)).toEqual([NsfwLevel.PG, NsfwLevel.PG13]);
  });

  it('an uncapped request hands the service every level', async () => {
    await call(true);
    expect(servedLevels(mock)).toEqual([...browsingLevels]);
  });
});
