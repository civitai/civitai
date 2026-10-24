import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

/**
 * `getImageGenerationData` decides visibility from the viewer it is given, so the procedure has to
 * pass the session's viewer. Without it every caller is treated as signed out: owners and
 * moderators lose generation data for their own unpublished or held images.
 */

const { mockGetImageGenerationData } = vi.hoisted(() => ({
  mockGetImageGenerationData: vi.fn(),
}));

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
  getImageGenerationData: (...args: unknown[]) => mockGetImageGenerationData(...args),
}));

import { imageRouter } from '../image.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Sentinels, so the test sees the request's own objects reach the service, not look-alikes.
const features = { canViewNsfw: true };
const req = { headers: {} };
const cache = { edgeTTL: 0 };

function callerFor(user: { id: number; isModerator?: boolean } | undefined) {
  return imageRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req,
    res: { setHeader: () => undefined },
    cache,
    features,
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

beforeEach(() => {
  mockGetImageGenerationData.mockReset().mockResolvedValue({ meta: undefined });
});

describe('image.getGenerationData viewer', () => {
  const viewerOf = () => {
    const [args] = mockGetImageGenerationData.mock.calls[0] as [
      { id: number; viewer: { user?: unknown; features?: unknown; req?: unknown; cache?: unknown } }
    ];
    return args;
  };

  it('passes the request context as the viewer', async () => {
    await callerFor({ id: 7 }).getGenerationData({ id: 3 });
    const { id, viewer } = viewerOf();
    expect(id).toBe(3);
    expect(viewer.user).toEqual({ id: 7 });
    expect(viewer.features).toBe(features);
    expect(viewer.req).toBe(req);
    expect(viewer.cache).toBe(cache);
    expect(mockGetImageGenerationData).toHaveBeenCalledTimes(1);
  });

  it('passes the moderator flag', async () => {
    await callerFor({ id: 7, isModerator: true }).getGenerationData({ id: 3 });
    expect(viewerOf().viewer.user).toEqual({ id: 7, isModerator: true });
  });

  it('takes the viewer from the session, never from the input', async () => {
    await callerFor({ id: 7 }).getGenerationData({
      id: 3,
      userId: 999,
      isModerator: true,
      viewer: { user: { id: 999, isModerator: true } },
    } as never);
    expect(Object.keys(viewerOf())).toEqual(['id', 'viewer']);
    expect(viewerOf().viewer.user).toEqual({ id: 7 });
  });

  it('passes no user when signed out', async () => {
    await callerFor(undefined).getGenerationData({ id: 3 });
    expect(viewerOf().viewer.user).toBeUndefined();
  });
});
