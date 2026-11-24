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
 * The post editor, reorder and the planner take no browsing level from the client, so each
 * procedure must hand the service the request's own cap. Without it a capped request shows the
 * owner's post images at every level.
 */

const { mockEditDetail, mockPlannerDetail, mockScheduled, mockReorder } = vi.hoisted(() => ({
  mockEditDetail: vi.fn(),
  mockPlannerDetail: vi.fn(),
  mockScheduled: vi.fn(),
  mockReorder: vi.fn(),
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
  reorderPostImages: (...args: unknown[]) => mockReorder(...args),
}));
vi.mock('~/server/services/post-planner.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostPlannerService>()),
  getPlannerPostDetail: (...args: unknown[]) => mockPlannerDetail(...args),
  getScheduledPosts: (...args: unknown[]) => mockScheduled(...args),
}));

const { postRouter } = await import('../post.router');
const { reorderPostImagesHandler } = await import('~/server/controllers/post.controller');

const OWNER = 10;

function callerFor(canViewNsfw: boolean) {
  return postRouter.createCaller({
    user: { id: OWNER, tier: 'free', username: 'owner', muted: false, onboarding: 0xff },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: { host: 'example.test' } },
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
  mockScheduled.mockReset().mockResolvedValue([]);
  mockReorder.mockReset().mockResolvedValue([]);
});

// Reorder goes through the handler: the router adds only the owner check before it.
const reorderAs = (canViewNsfw: boolean) =>
  reorderPostImagesHandler({
    input: { id: 1, imageIds: [2, 3] },
    ctx: {
      user: { id: OWNER },
      features: { canViewNsfw },
      req: { headers: { host: 'example.test' } },
    } as never,
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
  [
    'post.getScheduled',
    (canViewNsfw: boolean) =>
      callerFor(canViewNsfw).getScheduled({
        from: new Date('2026-11-01T00:00:00Z'),
        to: new Date('2026-11-08T00:00:00Z'),
      }),
    mockScheduled,
  ],
  ['post.reorderImages handler', reorderAs, mockReorder],
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

// The owner's view (their own held images) is passed only on a session or a full-access key; a
// MediaRead-scoped key reads the post as anyone else does.
const scopedKey = {
  apiKeyId: 7,
  apiKeyType: 'User',
  subject: { type: 'apiKey', id: 7 },
  tokenScope: TokenScope.MediaRead,
};
function ownerCaller(scoped: boolean) {
  return postRouter.createCaller({
    user: { id: OWNER, tier: 'free', username: 'owner', muted: false, onboarding: 0xff },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    ...(scoped ? scopedKey : {}),
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: true, postPlanner: true, trpcFlagGuardPerRequest: true },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}
const ownerViewOf = (mock: ReturnType<typeof vi.fn>) =>
  (mock.mock.calls.at(-1) as [{ ownerSeesHeld?: boolean }])[0].ownerSeesHeld;

describe.each([
  ['post.getEdit', (scoped: boolean) => ownerCaller(scoped).getEdit({ id: 1 }), mockEditDetail],
  [
    'post.getScheduled',
    (scoped: boolean) =>
      ownerCaller(scoped).getScheduled({
        from: new Date('2026-11-01T00:00:00Z'),
        to: new Date('2026-11-08T00:00:00Z'),
      }),
    mockScheduled,
  ],
  [
    'post.reorderImages handler',
    (scoped: boolean) =>
      reorderPostImagesHandler({
        input: { id: 1, imageIds: [2, 3] },
        ctx: {
          user: { id: OWNER },
          features: { canViewNsfw: true },
          ...(scoped ? scopedKey : {}),
        } as never,
      }),
    mockReorder,
  ],
] as const)("%s and the owner's view", (_name, call, mock) => {
  it('passes it on a session', async () => {
    await call(false);
    expect(ownerViewOf(mock)).toBe(true);
  });

  it('withholds it on a MediaRead-scoped key', async () => {
    await call(true);
    expect(ownerViewOf(mock)).toBe(false);
  });
});
