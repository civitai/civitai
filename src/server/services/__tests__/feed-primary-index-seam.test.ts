import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
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

// Hydration queries here. It returns no rows unless a test makes it fail.
const { pg, emptyPool } = vi.hoisted(() => {
  const pg = { fail: false, statements: [] as { text: string; values: unknown[] }[] };
  const query = async (text: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
    if (typeof text === 'string') pg.statements.push({ text, values: values ?? [] });
    else pg.statements.push({ text: text.text, values: text.values ?? [] });
    if (pg.fail) throw new Error('hydrate query failed');
    return { rows: [] };
  };
  const client = { query, release: () => undefined };
  return { pg, emptyPool: { connect: async () => client, query } };
});
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: emptyPool,
  pgDbReadLong: emptyPool,
  pgDbWrite: emptyPool,
}));
// The replica's user-id-by-username read (a Kysely statement).
const { getUserIdByUsername } = vi.hoisted(() => ({ getUserIdByUsername: vi.fn() }));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getUserIdByUsername,
}));
vi.mock('~/server/services/new-creators.service', () => ({
  getNewCreatorUserIds: vi.fn(async () => newCreatorIds()),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

const newCreatorIds = vi.fn((): number[] => []);
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    getFliptBoolean: vi.fn(async () => false),
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
import { restrictedMinorClause } from '~/__tests__/minor-clause';

const request = () =>
  ({
    sort: 'Most Reactions',
    period: 'Week',
    browsingLevel: 1,
    limit: 100,
    include: [],
    user: { id: 42, isModerator: false },
  } as unknown as Parameters<typeof getAllImagesIndex>[0]);

describe('getAllImagesIndex on the feed service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pg.fail = false;
    pg.statements = [];
  });

  it('answers a feed timeout with a retryable SERVICE_UNAVAILABLE', async () => {
    fetchFeedPrimary.mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await expect(getAllImagesIndex(request())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(fetchFeedPrimary).toHaveBeenCalledTimes(1);
  });

  it('scopes the feed to the creator a profile page names by username', async () => {
    getUserIdByUsername.mockResolvedValue({ id: 7 });
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
    await expect(
      getAllImagesIndex({ ...request(), sort: 'Newest', cursor: '30000|1788000000000' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetchFeedPrimary).not.toHaveBeenCalled();
  });

  it('hides challenge entries in the feed by excluding the challenge tag', async () => {
    fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [], nextCursor: undefined });
    await getAllImagesIndex({ ...request(), hideChallenges: true });
    const query = new URLSearchParams(fetchFeedPrimary.mock.calls[0][0] as string);
    expect(query.get('excludedTags')?.split(',')).toContain('676575');
  });

  it('refuses a cursor it cannot read instead of restarting the page from the search index', async () => {
    for (const cursor of ['feed', -1]) {
      await expect(getAllImagesIndex({ ...request(), cursor })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    expect(fetchFeedPrimary).not.toHaveBeenCalled();
  });

  it('scopes the feed to the new-creator board', async () => {
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
    newCreatorIds.mockReturnValue([11, 12]);
    fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [], nextCursor: undefined });
    await getAllImagesIndex({ ...request(), newCreators: true, newCreatorsMaxFollowers: 500 });
    expect(vi.mocked(getNewCreatorUserIds)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getNewCreatorUserIds)).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'images', maxFollowers: 500 })
    );
  });

  it('serves an unpopulated new-creator board as an empty feed', async () => {
    newCreatorIds.mockReturnValue([]);
    const r = await getAllImagesIndex({ ...request(), newCreators: true });
    expect(r).toMatchObject({ items: [], source: 'feed' });
    expect(fetchFeedPrimary).not.toHaveBeenCalled();
  });

  describe('hubs', () => {
    const hub = () => ({ ...request(), sort: 'Newest', period: 'AllTime', hubId: 12 });
    const sentQuery = () => new URLSearchParams(fetchFeedPrimary.mock.calls[0][0] as string);

    beforeEach(() => {
      fetchFeedPrimary.mockResolvedValue({
        status: 200,
        ms: 3,
        ids: [],
        nextCursor: undefined,
        route: 'union-walk',
      });
    });

    it('asks the feed for the hub as resolved for this viewer, on the owner view', async () => {
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
        asOwner: true,
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

    it("resolves a scoped key's hub as Public only: no owner id reaches the hub lookup", async () => {
      resolveHubSources.mockResolvedValue(hubSources({ userIds: [7] }));
      await getAllImagesIndex({ ...hub(), asOwner: false } as Parameters<
        typeof getAllImagesIndex
      >[0]);
      expect(resolveHubSources).toHaveBeenCalledWith(
        expect.objectContaining({ hubId: 12, userId: undefined, isModerator: false })
      );
    });

    it('asks only for the held level of a held model the hub serves', async () => {
      resolveHubSources.mockResolvedValue(hubSources({ userIds: [7], heldBrowsingLevel: 1 }));
      await getAllImagesIndex({ ...hub(), browsingLevel: 31 });
      expect(sentQuery().get('levels')).toBe('1');
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
      [
        'holds models that allow no level in common',
        hubSources({ userIds: [7], heldBrowsingLevel: 0 }),
      ],
    ])('serves a hub that %s as an empty feed, never the open one', async (_, sources) => {
      resolveHubSources.mockResolvedValue(sources);
      const r = await getAllImagesIndex(hub());
      expect(r).toMatchObject({ items: [], source: 'feed' });
      expect(fetchFeedPrimary).not.toHaveBeenCalled();
    });
  });
});

// `minorMatureImageVisibleSql`; what it keeps and drops is run against rows in
// minor-mature-image-visibility.behavior.test.ts.
const RESTRICTED_MINOR = restrictedMinorClause('g');

describe("the feed service's page hydrate, for restricted minor images", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pg.fail = false;
    pg.statements = [];
  });

  /** The hydrate statement for a served page of ids 1-5, as `user` sees it. */
  async function hydrateStatement(user: { id: number; isModerator: boolean }) {
    fetchFeedPrimary.mockResolvedValue({ status: 200, ms: 3, ids: [1, 2, 3, 4, 5] });
    // A session's views (credentialViews); the feed reads neither without them.
    await getAllImagesIndex({
      ...request(),
      browsingLevel: 31,
      user,
      asModerator: true,
      asOwner: true,
    }).catch(() => undefined);
    const hydrate = pg.statements.find((s) => s.text.includes('"Image" i'));
    expect(hydrate, 'the page is no longer hydrated through the pg pool').toBeDefined();
    return hydrate as { text: string; values: unknown[] };
  }

  it('drops a restricted minor image for a stranger and keeps an unflagged R image (control)', async () => {
    const stmt = await hydrateStatement({ id: 42, isModerator: false });
    const clauses = [...stmt.text.matchAll(RESTRICTED_MINOR)];
    expect(clauses).toHaveLength(1);
    const inlined = clauses[0][0].replace(/\$(\d+)/g, (_, n) => String(stmt.values[Number(n) - 1]));
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, minor boolean, "nsfwLevel" int);
      INSERT INTO "Image" VALUES
        (1, 7, true, 4), (2, 7, false, 4), (3, 7, NULL, 8), (4, 7, true, 2), (5, 42, true, 4);
    `);
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM "Image" i WHERE ${inlined} ORDER BY id`
    );
    // 1: another user's restricted minor image, hidden; 5: the viewer's own, kept.
    expect(rows.map((r) => r.id)).toEqual([2, 3, 4, 5]);
    await db.close();
  });

  it('applies no such clause for a moderator', async () => {
    // The same hydrate for a stranger carries it, so the pattern still finds the clause.
    const stranger = await hydrateStatement({ id: 42, isModerator: false });
    expect([...stranger.text.matchAll(RESTRICTED_MINOR)]).toHaveLength(1);
    pg.statements = [];
    const stmt = await hydrateStatement({ id: 42, isModerator: true });
    expect([...stmt.text.matchAll(RESTRICTED_MINOR)]).toHaveLength(0);
  });
});
