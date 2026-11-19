import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as ImageService from '~/server/services/image.service';
import {
  browsingLevels,
  parseBitwiseBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `image.getMyImages` takes no browsing level from the client, so the procedure must hand the
 * service the request's own cap. Without it a capped request lists the owner's images at every level.
 */

const { mockGetMyImages } = vi.hoisted(() => ({ mockGetMyImages: vi.fn() }));

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getMyImages: (...args: unknown[]) => mockGetMyImages(...args),
}));

const { imageRouter } = await import('../image.router');

const OWNER = 10;

function callerFor(canViewNsfw: boolean) {
  return imageRouter.createCaller({
    user: { id: OWNER, tier: 'free', username: 'owner', muted: false, onboarding: 0xff },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

const servedLevels = () => {
  const [args] = mockGetMyImages.mock.calls[0] as [{ userId: number; servableLevels: number }];
  expect(args.userId).toBe(OWNER);
  return parseBitwiseBrowsingLevel(args.servableLevels);
};

beforeEach(() => {
  mockGetMyImages.mockReset().mockResolvedValue({ items: [], nextCursor: undefined });
});

describe('image.getMyImages request cap', () => {
  it('a capped request (no NSFW on this domain) hands the service PG and PG13 only', async () => {
    await callerFor(false).getMyImages({ mediaTypes: [] });
    expect(servedLevels()).toEqual([NsfwLevel.PG, NsfwLevel.PG13]);
  });

  it('an uncapped request hands the service every level', async () => {
    await callerFor(true).getMyImages({ mediaTypes: [] });
    expect(servedLevels()).toEqual([...browsingLevels]);
  });
});
