import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The highest-consequence property in the hubs diff: a hub query must never reach
// the search backend without its source filter. Turning
//   `if (!hubFilter) return { data: [], nextCursor: undefined }`
// into
//   `if (hubFilter) filters.push(hubFilter)`
// is a one-token edit that serves the GLOBAL FEED as somebody's hub, with no
// error at any layer. These tests exist to turn that red.
//
// Minimal-seam mocking: `fetchDocuments`
// is stubbed and `metricsSearchClient` is left truthy — a null client short-
// circuits the builder before any filter is assembled, which would make an
// assertion about the emitted filter vacuous.

import type * as MeiliClient from '~/server/meilisearch/client';
import type * as FliptClient from '~/server/flipt/client';
import type * as UserHubService from '~/server/services/user-hub.service';
import type { ResolvedHubSources } from '~/server/services/user-hub.service';

const { fetchDocumentsMock, resolveHubSourcesMock } = vi.hoisted(() => ({
  fetchDocumentsMock: vi.fn(),
  resolveHubSourcesMock: vi.fn(),
}));

// Every stub goes through this, so a field added to `ResolvedHubSources` has one
// place to land rather than eight. It is NOT a compile gate: `resolveHubSourcesMock`
// is a bare `vi.fn()`, so `mockResolvedValue` takes `any`, and nothing in
// package.json, CI or scripts/ ever runs `tsconfig.tests.json`. What it buys is that
// a reader can see which fields a stub chose — an omitted `forcedBrowsingLevel`
// reads as "no cap" and would leave the cap tests green over a hub serving uncapped.
const hubSources = (over: Partial<ResolvedHubSources> = {}): ResolvedHubSources => ({
  userIds: [],
  modelVersionIds: [],
  collectionIds: [],
  tagIds: [],
  truncated: false,
  forcedBrowsingLevel: 0,
  excluded: { userIds: [], modelVersionIds: [], tagIds: [] },
  ...over,
});

vi.mock('../../../../event-engine-common/feeds', () => ({
  ImagesFeed: class {
    populatedQuery = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
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

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  metricsSearchClient: {},
  fetchDocumentsAbortable: fetchDocumentsMock,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  getFliptVariant: vi.fn().mockResolvedValue('off'),
  getFliptBoolean: vi.fn().mockResolvedValue(false),
}));

// `hubBrowsingLevel` is a pure function over the resolved sources and is spread
// through unmocked: replacing it would be replacing the very cap these tests check.
vi.mock('~/server/services/user-hub.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserHubService>()),
  resolveHubSources: resolveHubSourcesMock,
}));

import {
  getAllImages,
  getImagesFromFeedSearch,
  getImagesFromSearchPostFilter,
  getImagesFromSearchPreFilter,
} from '../image.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';

redisMock.redis.get.mockResolvedValue('[]');
redisMock.redis.set.mockResolvedValue(undefined);

// The builders take the full ImageSearchInput; only these fields are load-bearing
// for the hub arm, so the rest is left off rather than stubbed with fake values
// that would read as meaningful.
const input = (hubId?: number) =>
  ({
    hubId,
    currentUserId: 5,
    browsingLevel: 1,
    limit: 10,
    include: [],
    period: 'AllTime',
    sort: 'Newest',
  } as unknown as Parameters<typeof getImagesFromSearchPreFilter>[0]);

const emittedFilter = () => {
  const call = fetchDocumentsMock.mock.calls[0];
  return (call?.[1]?.filter ?? '') as string;
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchDocumentsMock.mockResolvedValue({ results: [], total: 0 });
});

describe('hub filter reaches the search backend', () => {
  it('emits every source arm, ORed together', async () => {
    resolveHubSourcesMock.mockResolvedValue(
      hubSources({ userIds: [10, 11], modelVersionIds: [20, 21] })
    );

    await getImagesFromSearchPreFilter(input(1));

    const filter = emittedFilter();
    // Asserted as ONE string, not arm by arm: every per-arm `toContain` stays green
    // when `' OR '` becomes `' AND '`, and an ANDed hub returns nothing at all.
    expect(filter).toContain(
      '(userId IN [10,11] OR postedToId IN [20,21] OR modelVersionIds IN [20,21] OR modelVersionIdsManual IN [20,21])'
    );
  });

  it('honours hideAutoResources and hideManualResources', async () => {
    // Without these gates a hub silently ignores two filters the user set.
    resolveHubSourcesMock.mockResolvedValue(hubSources({ modelVersionIds: [20] }));

    await getImagesFromSearchPreFilter({ ...input(1), hideAutoResources: true });

    const filter = emittedFilter();
    expect(filter).toContain('postedToId IN [20]');
    expect(filter).not.toContain('modelVersionIds IN');
    expect(filter).toContain('modelVersionIdsManual IN [20]');
  });

  it('does not search at all when the hub resolves to nothing', async () => {
    // Not-yours, or deleted. The failure this guards is serving the global feed:
    // asserting on the RESULT alone would pass either way, so assert that the
    // backend was never reached.
    resolveHubSourcesMock.mockResolvedValue(null);

    const result = await getImagesFromSearchPreFilter(input(1));

    expect(fetchDocumentsMock).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
  });

  it('does not search when the hub has no enabled sources', async () => {
    resolveHubSourcesMock.mockResolvedValue(hubSources());

    const result = await getImagesFromSearchPreFilter(input(1));

    expect(fetchDocumentsMock).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
  });

  it('leaves a non-hub query untouched', async () => {
    // The negative control: proves the assertions above are about the hub arm and
    // not about the builder refusing everything.
    await getImagesFromSearchPreFilter(input(undefined));

    expect(fetchDocumentsMock).toHaveBeenCalled();
    expect(emittedFilter()).not.toContain('postedToId IN');
    expect(resolveHubSourcesMock).not.toHaveBeenCalled();
  });
});

describe('a tag source joins the OR group', () => {
  it('emits the tag arm beside the others', async () => {
    resolveHubSourcesMock.mockResolvedValue(hubSources({ userIds: [10], tagIds: [77, 78] }));

    await getImagesFromSearchPreFilter(input(1));

    // One string, for the reason the first test in this file gives: per-arm
    // `toContain` survives ' OR ' becoming ' AND ', which is an empty hub.
    expect(emittedFilter()).toContain('(userId IN [10] OR tagIds IN [77,78])');
  });
});

/**
 * The keep-out group. Two mutations this has to catch, and the first is the one a
 * per-arm assertion misses:
 *
 *   `AND NOT (…)` -> `OR NOT (…)`   — the exclusion stops narrowing anything, and
 *                                     the hub serves the excluded content back.
 *   `NOT (a OR b)` -> `NOT (a AND b)` — only content matching BOTH is removed, so
 *                                     almost nothing is.
 *
 * Both are one-token edits inside a string nothing else reads, so the assertions
 * below quote the operators rather than the arms.
 */
describe('a hub keeps its excluded sources out', () => {
  // A NOT group opening on one of the hub's own fields. `String.raw` because a
  // template literal turns `` into a backspace, which matches nothing and makes
  // the control pass forever.
  const hubExclusionGroup = new RegExp(String.raw`NOT \((userId|tagIds|postedToId)`);

  const withExclusions = hubSources({
    userIds: [10],
    excluded: { userIds: [11], modelVersionIds: [20], tagIds: [77] },
  });

  it('ANDs a NOT group onto the source filter', async () => {
    resolveHubSourcesMock.mockResolvedValue(withExclusions);

    await getImagesFromSearchPreFilter(input(1));

    expect(emittedFilter()).toContain(
      '(userId IN [10]) AND NOT (userId IN [11] OR tagIds IN [77] OR postedToId IN [20] OR modelVersionIds IN [20] OR modelVersionIdsManual IN [20])'
    );
  });

  it('excludes a model under every resource attribution, not only the gated ones', async () => {
    // hideAutoResources/hideManualResources gate the INCLUSION arms. Letting them
    // reach the exclusion would serve a refused model back to anyone who happened to
    // have one of those filters on.
    resolveHubSourcesMock.mockResolvedValue(withExclusions);

    await getImagesFromSearchPreFilter({
      ...input(1),
      hideAutoResources: true,
      hideManualResources: true,
    });

    expect(emittedFilter()).toContain(
      'NOT (userId IN [11] OR tagIds IN [77] OR postedToId IN [20] OR modelVersionIds IN [20] OR modelVersionIdsManual IN [20])'
    );
  });

  it('emits no NOT group at all when the hub excludes nothing', async () => {
    // The negative control. Without it every assertion above passes for a builder
    // that hard-codes a NOT group, and an unconditional `NOT ()` is either a syntax
    // error Meili rejects or a filter that removes content nobody excluded.
    //
    // Matched on the ARM, not on a bare `NOT (`: the licence-restriction filter emits
    // its own NOT group on every request, so `not.toContain('NOT (')` fails whether or
    // not this code is correct.
    resolveHubSourcesMock.mockResolvedValue(hubSources({ userIds: [10] }));

    await getImagesFromSearchPreFilter(input(1));

    expect(fetchDocumentsMock).toHaveBeenCalled();
    expect(emittedFilter()).not.toMatch(hubExclusionGroup);
  });

  it('still serves the page — an exclusion narrows the feed, it does not empty it', async () => {
    resolveHubSourcesMock.mockResolvedValue(withExclusions);

    const result = await getImagesFromSearchPreFilter(input(1));

    expect(fetchDocumentsMock).toHaveBeenCalled();
    expect(result.data).toEqual([]);
  });

  it('the post-filter builder emits the same NOT group', async () => {
    // Per builder, not once: a per-user flag decides which one a request takes, and
    // the one nobody tested is the one the exclusion goes missing from.
    resolveHubSourcesMock.mockResolvedValue(withExclusions);

    await getImagesFromSearchPostFilter(input(1));

    expect(emittedFilter()).toContain(
      '(userId IN [10]) AND NOT (userId IN [11] OR tagIds IN [77] OR postedToId IN [20] OR modelVersionIds IN [20] OR modelVersionIdsManual IN [20])'
    );
  });

  it('the post-filter builder emits no NOT group without exclusions', async () => {
    resolveHubSourcesMock.mockResolvedValue(hubSources({ userIds: [10] }));

    await getImagesFromSearchPostFilter(input(1));

    expect(fetchDocumentsMock).toHaveBeenCalled();
    expect(emittedFilter()).not.toMatch(hubExclusionGroup);
  });
});

describe('the post-filter builder has the same guard', () => {
  // The guard exists in BOTH Meili builders, selected by the FEED_POST_FILTER
  // flag. Mutating one and watching the pre-filter tests go red proves nothing
  // about the other, and a per-user flag decides which one a given request gets.
  it('emits the hub arm', async () => {
    resolveHubSourcesMock.mockResolvedValue(hubSources({ userIds: [10] }));

    await getImagesFromSearchPostFilter(input(1));

    expect(emittedFilter()).toContain('userId IN [10]');
  });

  it('does not search when the hub resolves to nothing', async () => {
    resolveHubSourcesMock.mockResolvedValue(null);

    const result = await getImagesFromSearchPostFilter(input(1));

    expect(fetchDocumentsMock).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
  });
});

describe('builders that cannot serve a hub refuse it', () => {
  // The dispatcher sends every hubId down the index path, so reaching either of
  // these is a server routing bug and not something a caller can provoke: it
  // stays 5xx, where the alerting is, and the REST layer genericizes the message
  // rather than handing an anonymous caller the function name. A bare `Error`
  // gets re-wrapped by throwDbError; the TRPCError propagates intact.
  const expectInternalError = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e) => e
    );

    expect(
      error,
      'the builder refused with the wrong error type, or did not refuse at all'
    ).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    expect((error as TRPCError).message).toMatch(/cannot serve a hub/i);
  };

  it('getAllImages throws rather than returning an unfiltered page', async () => {
    // The backstop for the controller routing change: this path has no way to
    // express a hub, so arriving here means the dispatcher sent it wrongly.
    await expectInternalError(getAllImages(input(1)));
  });

  it('getImagesFromFeedSearch throws rather than returning an unfiltered page', async () => {
    await expectInternalError(getImagesFromFeedSearch(input(1)));
  });
});

/**
 * The hub's own content cap (subtask 868kwp5f2). Both builders apply it separately,
 * so a cap missing from one is a hub serving past its
 * own setting on whichever backend that request happened to take — with nothing
 * red anywhere. Asserted on the EMITTED level list rather than on the call, because
 * the call is identical with and without the cap.
 *
 * PG = 1, PG-13 = 2, R = 4. Viewer asks for PG|PG13|R, the hub allows PG|PG13.
 */
describe('a hub caps its own feed to the level the owner set', () => {
  const cappedSources = hubSources({ userIds: [10], forcedBrowsingLevel: 1 | 2 });

  const viewerWantsR = (hubId?: number) => ({ ...input(hubId), browsingLevel: 1 | 2 | 4 });

  it('the pre-filter builder emits only the levels the hub allows', async () => {
    resolveHubSourcesMock.mockResolvedValue(cappedSources);

    await getImagesFromSearchPreFilter(viewerWantsR(1));

    expect(emittedFilter()).toContain('nsfwLevel IN [1,2]');
    expect(emittedFilter()).not.toContain('nsfwLevel IN [1,2,4]');
  });

  it('the post-filter builder emits only the levels the hub allows', async () => {
    resolveHubSourcesMock.mockResolvedValue(cappedSources);

    await getImagesFromSearchPostFilter(viewerWantsR(1));

    expect(emittedFilter()).toContain('nsfwLevel IN [1,2]');
    expect(emittedFilter()).not.toContain('nsfwLevel IN [1,2,4]');
  });

  it('leaves the viewer alone when the hub sets no cap', async () => {
    // The negative control. Without it every assertion above passes for a builder
    // that hard-codes PG|PG-13 and never reads the viewer's level at all.
    resolveHubSourcesMock.mockResolvedValue({ ...cappedSources, forcedBrowsingLevel: 0 });

    await getImagesFromSearchPreFilter(viewerWantsR(1));

    expect(emittedFilter()).toContain('nsfwLevel IN [1,2,4]');
  });

  it('serves nothing rather than everything when the viewer and the hub do not overlap', async () => {
    // The dangerous direction: an empty intersection reaching the level block's
    // `if (!browsingLevel) browsingLevel = PG` fallback would show PG images from a
    // hub whose owner allowed only R.
    resolveHubSourcesMock.mockResolvedValue({ ...cappedSources, forcedBrowsingLevel: 4 });

    const result = await getImagesFromSearchPreFilter({ ...input(1), browsingLevel: 1 });

    expect(fetchDocumentsMock).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
  });

  it('the post-filter builder serves nothing on an empty intersection too', async () => {
    // Covered per builder, not once: the empty-intersection branch is two separate
    // `if (!capped)` lines, and the one that gets deleted is the one nobody tested.
    resolveHubSourcesMock.mockResolvedValue({ ...cappedSources, forcedBrowsingLevel: 4 });

    const result = await getImagesFromSearchPostFilter({ ...input(1), browsingLevel: 1 });

    expect(fetchDocumentsMock).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
  });
});

describe('what the builders hand resolveHubSources', () => {
  // The mock swallows these silently: delete `excludedSources` and every per-session
  // source toggle is inert; delete `isModerator` and a moderator gets an empty feed
  // on every private hub. Both are one-line deletions in the layer where the
  // behaviour lives, and no assertion about the emitted FILTER can see either.
  it('passes the viewer identity and this session exclusions through', async () => {
    resolveHubSourcesMock.mockResolvedValue(hubSources({ userIds: [10] }));

    await getImagesFromSearchPreFilter({
      ...input(1),
      isModerator: true,
      hubExcludedSources: [{ type: UserHubSourceType.User, targetId: 11 }],
    } as Parameters<typeof getImagesFromSearchPreFilter>[0]);

    expect(resolveHubSourcesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hubId: 1,
        userId: 5,
        isModerator: true,
        excludedSources: [{ type: UserHubSourceType.User, targetId: 11 }],
      })
    );
  });

  it('does not invent a viewer or an exclusion list when the request carries none', async () => {
    // The negative control. Without it the assertion above passes for a builder that
    // hard-codes both, which is the same as not reading the input at all.
    resolveHubSourcesMock.mockResolvedValue(hubSources({ userIds: [10] }));

    await getImagesFromSearchPreFilter(input(1));

    expect(resolveHubSourcesMock).toHaveBeenCalledWith(
      expect.objectContaining({ isModerator: undefined, excludedSources: undefined })
    );
  });
});

describe('the unscanned-image arm is not open to anonymous callers', () => {
  // `nsfwLevel = 0` is never-scanned content. It is ORed past the browsing level so a
  // caller can see their OWN unscanned uploads — which needs a caller. Unpaired, the
  // arm is every unscanned image on the site, to everyone logged out.
  const anonymous = () =>
    ({
      currentUserId: undefined,
      browsingLevel: 1,
      limit: 10,
      include: [],
      period: 'AllTime',
      sort: 'Newest',
    } as unknown as Parameters<typeof getImagesFromSearchPreFilter>[0]);

  it('omits the arm entirely with no signed-in caller', async () => {
    await getImagesFromSearchPreFilter(anonymous());

    // The `not.toContain` is only worth anything if a filter was emitted at all:
    // `emittedFilter()` returns '' when nothing was searched, and '' satisfies it.
    expect(fetchDocumentsMock).toHaveBeenCalled();
    expect(emittedFilter()).not.toContain('nsfwLevel = 0');
  });

  it('still gives a signed-in caller their own unscanned uploads', async () => {
    // The control: without it the assertion above passes for a builder that dropped
    // the arm for everybody, which is a different regression.
    await getImagesFromSearchPreFilter({ ...anonymous(), currentUserId: 5 });

    expect(emittedFilter()).toContain('(nsfwLevel = 0 AND userId = 5)');
  });

  // The post-filter builder carries the same arm under a TIGHTER condition — own
  // content, on your own user page. Deleting `&& userId === currentUserId` there ORs
  // every unscanned image on the site into every signed-in caller's feed: the bug
  // just fixed in the pre-filter, in the builder a per-user flag routes some
  // requests to.
  it('the post-filter builder scopes its arm to the caller viewing their own page', async () => {
    await getImagesFromSearchPostFilter({ ...anonymous(), currentUserId: 5, userId: 5 });

    expect(fetchDocumentsMock).toHaveBeenCalled();
    expect(emittedFilter()).toContain('nsfwLevel = 0');
  });

  it('the post-filter builder omits its arm when the caller is looking elsewhere', async () => {
    await getImagesFromSearchPostFilter({ ...anonymous(), currentUserId: 5, userId: 99 });

    expect(fetchDocumentsMock).toHaveBeenCalled();
    expect(emittedFilter()).not.toContain('nsfwLevel = 0');
  });
});
