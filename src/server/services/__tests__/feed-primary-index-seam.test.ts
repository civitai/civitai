import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as FliptClient from '~/server/flipt/client';
import type * as FeedPrimary from '~/server/services/feed-primary.service';
import type * as UserHubService from '~/server/services/user-hub.service';
import type { ResolvedHubSources } from '~/server/services/user-hub.service';

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
const hubsOn = vi.fn(() => false);
const newCreatorIds = vi.fn((): number[] => []);
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    getFliptBoolean: vi.fn(async (flag: string) => {
      if (flag === actual.FLIPT_FEATURE_FLAGS.FEED_SERVICE_PRIMARY) return primaryOn();
      if (flag === actual.FLIPT_FEATURE_FLAGS.FEED_SERVICE_HUBS) return hubsOn();
      return false;
    }),
  };
});
const resolveHubSources = vi.fn();
vi.mock('~/server/services/user-hub.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserHubService>()),
  resolveHubSources: (...args: unknown[]) => resolveHubSources(...args),
}));
const hubSources = (over: Partial<ResolvedHubSources> = {}): ResolvedHubSources => ({
  userIds: [],
  modelVersionIds: [],
  collectionIds: [],
  tagGroups: [],
  truncated: false,
  forcedBrowsingLevel: 0,
  excluded: { userIds: [], modelVersionIds: [], tagGroups: [] },
  ...over,
});
const fetchFeedPrimary = vi.fn();
vi.mock('~/server/services/feed-primary.service', async (importOriginal) => {
  const actual = await importOriginal<typeof FeedPrimary>();
  return { ...actual, fetchFeedPrimary: (...args: unknown[]) => fetchFeedPrimary(...args) };
});

import { getAllImagesIndex } from '../image.service';
import { getNewCreatorUserIds } from '~/server/services/new-creators.service';
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

  it('refuses a cursor it cannot read instead of restarting the page from the search index', async () => {
    primaryOn.mockReturnValue(true);
    for (const cursor of ['feed', -1]) {
      await expect(getAllImagesIndex({ ...request(), cursor })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    expect(fetchFeedPrimary).not.toHaveBeenCalled();
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

  // The home block's follower cap rides on the input. If a route drops it, that route serves the
  // uncapped board and the 1k+ creators come back to the homepage shelf.
  it('resolves the follower-capped board when the caller asks for one', async () => {
    primaryOn.mockReturnValue(true);
    newCreatorIds.mockReturnValue([11, 12]);
    fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [], nextCursor: undefined });
    await getAllImagesIndex({ ...request(), newCreators: true, newCreatorsMaxFollowers: 500 });
    expect(vi.mocked(getNewCreatorUserIds)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getNewCreatorUserIds)).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'images', maxFollowers: 500 })
    );
  });

  it('serves an unpopulated new-creator board as an empty feed', async () => {
    primaryOn.mockReturnValue(true);
    newCreatorIds.mockReturnValue([]);
    const r = await getAllImagesIndex({ ...request(), newCreators: true });
    expect(r).toMatchObject({ items: [], source: 'feed' });
    expect(fetchFeedPrimary).not.toHaveBeenCalled();
  });

  describe('hubs', () => {
    const hub = () => ({ ...request(), sort: 'Newest', period: 'AllTime', hubId: 12 });
    const sentQuery = () => new URLSearchParams(fetchFeedPrimary.mock.calls[0][0] as string);

    beforeEach(() => {
      primaryOn.mockReturnValue(true);
      hubsOn.mockReturnValue(true);
      fetchFeedPrimary.mockResolvedValue({
        status: 200,
        ms: 3,
        ids: [],
        nextCursor: undefined,
        route: 'union-walk',
      });
    });

    it('leaves a hub on the search index until hubs are switched over', async () => {
      hubsOn.mockReturnValue(false);
      resolveHubSources.mockResolvedValue(hubSources({ userIds: [7] }));
      const r = await getAllImagesIndex(hub());
      expect(fetchFeedPrimary).not.toHaveBeenCalled();
      expect(r.source).not.toBe('feed');
    });

    it('asks the feed for the hub as resolved for this viewer', async () => {
      resolveHubSources.mockResolvedValue(
        hubSources({
          userIds: [7],
          modelVersionIds: [290640],
          tagGroups: [[5132, 4855]],
          excluded: { userIds: [3], modelVersionIds: [298112], tagGroups: [[66]] },
        })
      );
      const r = await getAllImagesIndex({
        ...hub(),
        hubExcludedSources: [{ type: 'User', targetId: 9 }],
      } as Parameters<typeof getAllImagesIndex>[0]);

      expect(r.source).toBe('feed');
      expect(resolveHubSources).toHaveBeenCalledWith({
        hubId: 12,
        userId: 42,
        isModerator: false,
        excludedSources: [{ type: 'User', targetId: 9 }],
      });
      const q = sentQuery();
      expect(q.get('anyUserIds')).toBe('7');
      expect(q.get('anyVersionIds')).toBe('290640');
      expect(q.get('anyTagGroups')).toBe('5132,4855');
      expect(q.get('excludedUserIds')).toBe('3');
      expect(q.get('excludedVersionIds')).toBe('298112');
      expect(q.get('excludedTagGroups')).toBe('66');
    });

    it('asks only for the levels the hub allows', async () => {
      resolveHubSources.mockResolvedValue(hubSources({ userIds: [7], forcedBrowsingLevel: 3 }));
      await getAllImagesIndex({ ...hub(), browsingLevel: 31 });
      expect(sentQuery().get('levels')).toBe('1,2');
    });

    it.each([
      ['the viewer may not open', null],
      ['has no source left', hubSources()],
      // Collection sources are served by neither path yet, so they are not a source.
      ['holds only collections', hubSources({ collectionIds: [5] })],
      [
        'caps below everything the viewer browses',
        hubSources({ userIds: [7], forcedBrowsingLevel: 16 }),
      ],
    ])('serves a hub that %s as an empty feed, never the open one', async (_, sources) => {
      resolveHubSources.mockResolvedValue(sources);
      const r = await getAllImagesIndex(hub());
      expect(r).toMatchObject({ items: [], source: 'feed' });
      expect(fetchFeedPrimary).not.toHaveBeenCalled();
    });
  });
});
