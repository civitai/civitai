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

function callerFor(user: { id: number; isModerator?: boolean } | undefined) {
  return imageRouter.createCaller({
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
  mockGetImageGenerationData.mockReset().mockResolvedValue({ meta: undefined });
});

describe('image.getGenerationData viewer', () => {
  it('passes the signed-in viewer', async () => {
    await callerFor({ id: 7 }).getGenerationData({ id: 3 });
    expect(mockGetImageGenerationData).toHaveBeenCalledWith({
      id: 3,
      userId: 7,
      isModerator: undefined,
    });
  });

  it('passes the moderator flag', async () => {
    await callerFor({ id: 7, isModerator: true }).getGenerationData({ id: 3 });
    expect(mockGetImageGenerationData).toHaveBeenCalledWith({
      id: 3,
      userId: 7,
      isModerator: true,
    });
  });

  it('takes the viewer from the session, never from the input', async () => {
    await callerFor({ id: 7 }).getGenerationData({
      id: 3,
      userId: 999,
      isModerator: true,
    } as never);
    expect(mockGetImageGenerationData).toHaveBeenCalledWith({
      id: 3,
      userId: 7,
      isModerator: undefined,
    });
  });

  it('passes no viewer when signed out', async () => {
    await callerFor(undefined).getGenerationData({ id: 3 });
    expect(mockGetImageGenerationData).toHaveBeenCalledWith({
      id: 3,
      userId: undefined,
      isModerator: undefined,
    });
  });
});
