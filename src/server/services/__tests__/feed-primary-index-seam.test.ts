import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as FliptClient from '~/server/flipt/client';
import type * as FeedPrimary from '~/server/services/feed-primary.service';

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/new-creators.service', () => ({
  getNewCreatorUserIds: vi.fn(async () => newCreatorIds()),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

const primaryOn = vi.fn(() => false);
const newCreatorIds = vi.fn((): number[] => []);
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    getFliptBoolean: vi.fn(async (flag: string) =>
      flag === actual.FLIPT_FEATURE_FLAGS.FEED_SERVICE_PRIMARY ? primaryOn() : false
    ),
  };
});
const fetchFeedPrimary = vi.fn();
vi.mock('~/server/services/feed-primary.service', async (importOriginal) => {
  const actual = await importOriginal<typeof FeedPrimary>();
  return { ...actual, fetchFeedPrimary: (...args: unknown[]) => fetchFeedPrimary(...args) };
});

import { getAllImagesIndex } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const request = () =>
  ({
    sort: 'Most Reactions',
    period: 'Week',
    browsingLevel: 1,
    limit: 100,
    include: [],
    user: { id: 42, isModerator: false },
  } as unknown as Parameters<typeof getAllImagesIndex>[0]);

describe('getAllImagesIndex with feed-service-primary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not ask the feed when the flag is off', async () => {
    primaryOn.mockReturnValue(false);
    await getAllImagesIndex(request());
    expect(fetchFeedPrimary).not.toHaveBeenCalled();
  });

  it('asks the feed once and falls through to the search path when hydration yields nothing', async () => {
    primaryOn.mockReturnValue(true);
    fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [9, 5], nextCursor: '17|5' });
    const r = await getAllImagesIndex(request());
    expect(fetchFeedPrimary).toHaveBeenCalledTimes(1);
    expect(r.source).not.toBe('feed');
    expect(r.nextCursor).toBeUndefined();
  });

  it('asks the feed once and falls through when the feed itself fails', async () => {
    primaryOn.mockReturnValue(true);
    fetchFeedPrimary.mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    const r = await getAllImagesIndex(request());
    expect(fetchFeedPrimary).toHaveBeenCalledTimes(1);
    expect(r.items).toEqual([]);
  });

  it('scopes the feed to the creator a profile page names by username', async () => {
    primaryOn.mockReturnValue(true);
    dbMock.dbRead.user.findUnique.mockResolvedValue({ id: 7 });
    fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [], nextCursor: undefined });
    await getAllImagesIndex({
      ...request(),
      sort: 'Newest',
      period: 'AllTime',
      username: 'someone',
    });
    expect(fetchFeedPrimary).toHaveBeenCalledWith(
      expect.stringContaining('userIds=7'),
      expect.anything()
    );
  });

  it('refuses a page past the offset cap instead of answering it from the search index', async () => {
    primaryOn.mockReturnValue(true);
    await expect(
      getAllImagesIndex({ ...request(), sort: 'Newest', cursor: '30000|1788000000000' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetchFeedPrimary).not.toHaveBeenCalled();
  });

  it('hides challenge entries in the feed by excluding the challenge tag', async () => {
    primaryOn.mockReturnValue(true);
    fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [], nextCursor: undefined });
    await getAllImagesIndex({ ...request(), hideChallenges: true });
    const query = new URLSearchParams(fetchFeedPrimary.mock.calls[0][0] as string);
    expect(query.get('excludedTags')?.split(',')).toContain('676575');
  });

  it('scopes the feed to the new-creator board', async () => {
    primaryOn.mockReturnValue(true);
    newCreatorIds.mockReturnValue([11, 12]);
    fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [], nextCursor: undefined });
    await getAllImagesIndex({ ...request(), newCreators: true });
    expect(fetchFeedPrimary).toHaveBeenCalledWith(
      expect.stringContaining('userIds=11%2C12'),
      expect.anything()
    );
  });

  it('serves an unpopulated new-creator board as an empty feed', async () => {
    primaryOn.mockReturnValue(true);
    newCreatorIds.mockReturnValue([]);
    const r = await getAllImagesIndex({ ...request(), newCreators: true });
    expect(r).toMatchObject({ items: [], source: 'feed' });
    expect(fetchFeedPrimary).not.toHaveBeenCalled();
  });
});
