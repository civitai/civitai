import { afterEach, describe, expect, it, vi } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  encodeFeedCursor,
  mapSearchInputToFeedQuery,
  parseFeedCursor,
  fetchFeedAnswer,
} from '../feed-shadow.service';

const base = { sort: 'Most Reactions', period: 'Week', browsingLevel: 31, limit: 100 };

describe('fetchFeedAnswer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the active trace context so the feed joins the request trace', async () => {
    const provider = new NodeTracerProvider();
    provider.register();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ items: [] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const span = provider.getTracer('t').startSpan('page');
    try {
      await context.with(trace.setSpan(context.active(), span), () =>
        fetchFeedAnswer('http://feed', 'levels=1', 1000, 'primary')
      );
    } finally {
      span.end();
      await provider.shutdown();
      context.disable();
      trace.disable();
      propagation.disable();
    }
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers.traceparent).toBe(
      `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`
    );
    expect(headers['x-request-source']).toBe('primary');
  });
});

describe('fetchFeedAnswer refusals', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the feed's reason for a 400 and nothing for other failures", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"error":{"fieldErrors":{"tools":["Invalid input"]}}}', { status: 400 })
      )
    );
    const refused = await fetchFeedAnswer('http://feed', 'tools=1', 1000, 'primary');
    expect(refused.status).toBe(400);
    expect(refused.ids).toEqual([]);
    expect(refused.error).toContain('tools');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 503 }))
    );
    const down = await fetchFeedAnswer('http://feed', 'tools=1', 1000, 'primary');
    expect(down).toMatchObject({ status: 503, ids: [] });
    expect(down.error).toBeUndefined();
  });
});

describe('meta flags', () => {
  it('asks the feed for images with visible meta, and for on-site ones', () => {
    const m = mapSearchInputToFeedQuery({ ...base, withMeta: true, fromPlatform: true });
    const q = m.ok ? new URLSearchParams(m.query) : new URLSearchParams();
    expect(q.get('withMeta')).toBe('1');
    expect(q.get('fromPlatform')).toBe('1');
  });
});

describe('real-person and minor settings', () => {
  it('asks the feed to drop flagged media, keeping a signed-in viewer their own', () => {
    const query = (i: Record<string, unknown>) => {
      const m = mapSearchInputToFeedQuery({ ...base, ...i });
      return new URLSearchParams(m.ok ? m.query : '');
    };
    const viewer = query({ disablePoi: true, disableMinor: true, currentUserId: 42 });
    expect(viewer.get('excludePoi')).toBe('1');
    expect(viewer.get('excludeMinor')).toBe('1');
    expect(viewer.get('viewerId')).toBe('42');
    expect(query({ disablePoi: true }).get('viewerId')).toBeNull();
    expect(query({ currentUserId: 42 }).get('viewerId')).toBeNull();
  });
});

describe('mapSearchInputToFeedQuery', () => {
  it('maps the search shape onto the feed query', () => {
    const m = mapSearchInputToFeedQuery({
      ...base,
      tags: [5],
      excludedTagIds: [7, 8],
      excludedUserIds: [9],
      modelVersionId: 290640,
      types: ['image'],
      baseModels: ['Pony'],
      useCombinedNsfwLevel: true,
      cursor: '400|1788000012345',
    });
    expect(m.ok).toBe(true);
    const q = m.ok ? new URLSearchParams(m.query) : new URLSearchParams();
    expect(q.get('levels')).toBe('1,2,4,8,16');
    expect(q.get('combinedLevels')).toBe('1');
    expect(q.get('tags')).toBe('5');
    expect(q.get('excludedTags')).toBe('7,8');
    expect(q.get('excludedUserIds')).toBe('9');
    expect(q.get('versionIds')).toBe('290640');
    expect(q.get('sort')).toBe('reactions');
    expect(q.get('periodDays')).toBe('7');
    expect(q.get('offset')).toBe('400');
    expect(q.get('before')).toBeNull();
  });

  it('freezes a paged set at the cursor minute only for Newest, as the site does', () => {
    const q = (sort: string) => {
      const m = mapSearchInputToFeedQuery({ ...base, sort, cursor: '400|1788000012345' });
      return m.ok ? new URLSearchParams(m.query) : new URLSearchParams();
    };
    expect(q('Newest').get('before')).toBe('1788000000000');
    expect(q('Most Reactions').get('before')).toBeNull();
    expect(q('Oldest').get('before')).toBeNull();
  });

  it('names any cursor it cannot read, after every other reason', () => {
    for (const cursor of ['feed', 'meili', -1, new Date(0), 'abc|1'])
      expect(mapSearchInputToFeedQuery({ ...base, cursor })).toEqual({
        ok: false,
        reason: 'cursor:unparsed',
      });
    expect(mapSearchInputToFeedQuery({ ...base, cursor: 'feed', sort: 'Random' })).toEqual({
      ok: false,
      reason: 'sort:Random',
    });
  });

  it('pages a bare offset cursor like an offset|entry one, without freezing the set', () => {
    for (const cursor of ['400', 400]) {
      const m = mapSearchInputToFeedQuery({ ...base, sort: 'Newest', cursor });
      const q = new URLSearchParams(m.ok ? m.query : '');
      expect(q.get('offset')).toBe('400');
      expect(q.get('before')).toBeNull();
    }
  });

  it('ignores the resource filters unless a model version gives them something to narrow', () => {
    const flags = { hideAutoResources: true, hideManualResources: true };
    expect(mapSearchInputToFeedQuery({ ...base, ...flags }).ok).toBe(true);
    expect(mapSearchInputToFeedQuery({ ...base, ...flags, modelVersionId: 9 })).toEqual({
      ok: false,
      reason: 'flag:hideAutoResources',
    });
  });

  it('names the first thing it cannot express', () => {
    const reason = (i: Record<string, unknown>) => {
      const m = mapSearchInputToFeedQuery({ ...base, ...i });
      return m.ok ? 'ok' : m.reason;
    };
    expect(reason({ followed: true, currentUserId: 9 })).toBe('flag:followed');
    expect(reason({ followed: true })).toBe('ok');
    expect(reason({ postId: 4 })).toBe('input:postId');
    expect(reason({ remixOfId: 4 })).toBe('input:remixOfId');
    expect(reason({ remixesOnly: true })).toBe('flag:remixesOnly');
    expect(reason({ nonRemixesOnly: true })).toBe('flag:nonRemixesOnly');
    expect(reason({ modelId: 4 })).toBe('modelId');
    expect(reason({ cursor: '30000|1788000000000' })).toBe('offset>20000');
    expect(reason({ sort: 'Random' })).toBe('sort:Random');
    expect(reason({ notPublished: true })).toBe('flag:unpublished:no-user');
    expect(reason({ notPublished: true, userId: 3 })).toBe('ok');
    expect(reason({ tags: [0] })).toBe('tags:none');
    expect(reason({ tags: [0, 5] })).toBe('ok');
  });

  it('serves a post page to the public API only, in the requested sort', () => {
    const website = mapSearchInputToFeedQuery({ ...base, postId: 4 }, 'primary', 'website');
    expect(website).toEqual({ ok: false, reason: 'input:postId' });
    const rest = mapSearchInputToFeedQuery(
      { ...base, postId: 4, sort: 'Newest' },
      'primary',
      'rest'
    );
    expect(rest.ok).toBe(true);
    const q = rest.ok ? new URLSearchParams(rest.query) : new URLSearchParams();
    expect(q.get('postIds')).toBe('4');
    expect(q.get('sort')).toBe('newest');
    const both = mapSearchInputToFeedQuery(
      { ...base, postId: 4, postIds: [5, 4] },
      'primary',
      'rest'
    );
    expect(both.ok && new URLSearchParams(both.query).get('postIds')).toBe('5,4');
    const many = { ...base, postIds: Array.from({ length: 51 }, (_, i) => i + 1) };
    expect(mapSearchInputToFeedQuery(many, 'primary', 'rest')).toEqual({
      ok: false,
      reason: 'postIds>50',
    });
  });

  it("serves the gallery's post completion to the website, whole or not at all", () => {
    const completion = { ...base, postIds: [5, 4], postIdsInRequestedSort: true, limit: 37 };
    const m = mapSearchInputToFeedQuery(completion, 'primary', 'website');
    expect(m.ok).toBe(true);
    const q = m.ok ? new URLSearchParams(m.query) : new URLSearchParams();
    expect(q.get('postIds')).toBe('5,4');
    expect(q.get('limit')).toBe('37');
    // A post page without the opt-in keeps its Postgres path.
    expect(mapSearchInputToFeedQuery({ ...base, postIds: [5, 4] }, 'primary', 'website')).toEqual({
      ok: false,
      reason: 'input:postId',
    });
    // More rows than the feed answers would leave posts short: refused, not capped.
    expect(mapSearchInputToFeedQuery({ ...completion, limit: 201 }, 'primary', 'website')).toEqual({
      ok: false,
      reason: 'postIds:limit>200',
    });
    expect(mapSearchInputToFeedQuery({ ...completion, limit: 200 }, 'primary', 'website').ok).toBe(
      true
    );
  });

  it('serves a follow feed only from a resolved follow list the feed can take', () => {
    const signedIn = { ...base, currentUserId: 9, followed: true };
    const m = mapSearchInputToFeedQuery({ ...signedIn, followedUserIds: [7, 3, 0] });
    expect(m.ok && new URLSearchParams(m.query).get('userIds')).toBe('7,3');
    const reason = (i: Record<string, unknown>) => {
      const r = mapSearchInputToFeedQuery({ ...signedIn, ...i });
      return r.ok ? 'ok' : r.reason;
    };
    expect(reason({})).toBe('flag:followed');
    const anon = mapSearchInputToFeedQuery({ ...base, followed: true });
    expect(anon.ok && new URLSearchParams(anon.query).has('userIds')).toBe(false);
    expect(reason({ followedUserIds: Array.from({ length: 10_001 }, (_, i) => i + 1) })).toBe(
      'followed>10000'
    );
    expect(reason({ followedUserIds: [7], userId: 7 })).toBe('flag:followed:userId');
  });

  it('continues a feed-served page only when the feed is primary', () => {
    const input = { ...base, cursor: 'feed:17808:68701222', offset: 300 };
    expect(mapSearchInputToFeedQuery(input)).toEqual({ ok: false, reason: 'cursor:feed' });
    const m = mapSearchInputToFeedQuery(input, 'primary');
    const q = m.ok ? new URLSearchParams(m.query) : new URLSearchParams();
    expect(q.get('cursor')).toBe('17808|68701222');
    expect(q.has('offset')).toBe(false);
    expect(encodeFeedCursor('1788000012345|42')).toBe('feed:1788000012345:42');
    expect(parseFeedCursor('400|1788000012345')).toBeUndefined();
  });
});

describe('jump to month', () => {
  const creator = { ...base, period: 'AllTime', userId: 7, jumpTo: '2025-03' };
  const sent = (input: Parameters<typeof mapSearchInputToFeedQuery>[0]) => {
    const m = mapSearchInputToFeedQuery(input, 'primary');
    if (!m.ok) throw new Error(`refused: ${m.reason}`);
    return new URLSearchParams(m.query);
  };

  it('starts Newest at the last instant of the month and Oldest at its first', () => {
    expect(sent({ ...creator, sort: 'Newest' }).get('cursor')).toBe(
      `${Date.UTC(2025, 3, 1) - 1}|2147483647`
    );
    expect(sent({ ...creator, sort: 'Oldest' }).get('cursor')).toBe(`${Date.UTC(2025, 2, 1)}|0`);
  });

  it('continues from the feed cursor once paging has started', () => {
    expect(
      sent({ ...creator, sort: 'Newest', cursor: 'feed:1740000000000:55' }).get('cursor')
    ).toBe('1740000000000|55');
  });

  it('starts at the top for a sort or a feed that has no place in time to start from', () => {
    expect(sent({ ...creator, sort: 'Most Reactions' }).has('cursor')).toBe(false);
    expect(sent({ ...creator, sort: 'Newest', userId: undefined }).has('cursor')).toBe(false);
  });

  it('leaves a jumped page the feed cannot place to the search index', () => {
    expect(mapSearchInputToFeedQuery({ ...creator, sort: 'Newest' }, 'shadow')).toEqual({
      ok: false,
      reason: 'jumpTo:shadow',
    });
    expect(
      mapSearchInputToFeedQuery(
        { ...creator, sort: 'Newest', cursor: '20|1743465600000' },
        'primary'
      )
    ).toEqual({ ok: false, reason: 'jumpTo:offset' });
  });
});

describe('hub feeds', () => {
  const sources = {
    userIds: [7, 9],
    modelVersionIds: [290640, 297100],
    collectionIds: [],
    tagGroups: [[5132], [5133, 4855]],
    excluded: { userIds: [3], modelVersionIds: [298112], tagGroups: [[2539, 66], [111]] },
  };
  const hub = { ...base, sort: 'Newest', period: 'AllTime', hubId: 12 };
  const query = (i: Record<string, unknown>) => {
    const m = mapSearchInputToFeedQuery({ ...hub, ...i });
    return m.ok ? new URLSearchParams(m.query) : undefined;
  };
  const reason = (i: Record<string, unknown>) => {
    const m = mapSearchInputToFeedQuery({ ...hub, ...i });
    return m.ok ? 'ok' : m.reason;
  };

  it('sends a resolved hub as any-of sources and keep-out lists', () => {
    const q = query({ hubSources: sources });
    expect(q?.get('anyUserIds')).toBe('7,9');
    expect(q?.get('anyVersionIds')).toBe('290640,297100');
    expect(q?.get('anyTagGroups')).toBe('5132;5133,4855');
    expect(q?.get('excludedUserIds')).toBe('3');
    expect(q?.get('excludedVersionIds')).toBe('298112');
    expect(q?.get('excludedTagGroups')).toBe('2539,66;111');
    // The sources are a union: sent as a creator or version filter they would be an AND.
    expect(q?.has('userIds')).toBe(false);
    expect(q?.has('versionIds')).toBe(false);
  });

  it('never sends a hub without a source', () => {
    // Unresolved is the shadow hook; without a source the query is the open feed.
    expect(reason({})).toBe('input:hubId');
    expect(reason({ hubSources: null })).toBe('input:hubId');
    const none = { ...sources, userIds: [], modelVersionIds: [], tagGroups: [] };
    expect(reason({ hubSources: none })).toBe('hub:none');
    // Collections are not served on either path yet, so a hub of only those has no source.
    expect(reason({ hubSources: { ...none, collectionIds: [4] } })).toBe('hub:none');
  });

  it('refuses a hub whose ids it would have to trim', () => {
    // Dropping the 0 would widen "5133 and 0" to "5133", and shorten a keep-out list.
    expect(reason({ hubSources: { ...sources, tagGroups: [[5133, 0]] } })).toBe('hub:ids');
    expect(reason({ hubSources: { ...sources, tagGroups: [[]] } })).toBe('hub:ids');
    const excluded = { ...sources.excluded, modelVersionIds: [0] };
    expect(reason({ hubSources: { ...sources, excluded } })).toBe('hub:ids');
  });

  it('keeps the hub exclusions when the hidden-creator list is cut at the limit', () => {
    const hidden = Array.from({ length: 1000 }, (_, i) => i + 100);
    const q = query({ hubSources: sources, excludedUserIds: hidden });
    const sent = q?.get('excludedUserIds')?.split(',') ?? [];
    expect(sent).toHaveLength(1000);
    expect(sent[0]).toBe('3');
  });

  it('refuses a hub past the limits of the feed instead of sending part of it', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    expect(reason({ hubSources: { ...sources, userIds: many(51) } })).toBe('hub:users>50');
    expect(reason({ hubSources: { ...sources, modelVersionIds: many(751) } })).toBe(
      'hub:versions>750'
    );
    expect(reason({ hubSources: { ...sources, modelVersionIds: many(750) } })).toBe('ok');
    const excluded = { ...sources.excluded, modelVersionIds: many(751) };
    expect(reason({ hubSources: { ...sources, excluded } })).toBe('hub:excludedVersions>750');
    const groups = { ...sources.excluded, tagGroups: many(21).map((t) => [t]) };
    expect(reason({ hubSources: { ...sources, excluded: groups } })).toBe(
      'hub:excludedTagGroups>20'
    );
  });

  it('leaves the resource filters to Meilisearch only when the hub has versions to narrow', () => {
    expect(reason({ hubSources: sources, hideAutoResources: true })).toBe('flag:hideAutoResources');
    expect(reason({ hubSources: sources, hideManualResources: true })).toBe(
      'flag:hideManualResources'
    );
    const noVersions = { ...sources, modelVersionIds: [] };
    expect(reason({ hubSources: noVersions, hideAutoResources: true })).toBe('ok');
  });

  it('refuses a post page next to the hub', () => {
    const m = mapSearchInputToFeedQuery(
      {
        ...base,
        hubId: 1,
        hubSources: {
          userIds: [1],
          modelVersionIds: [],
          tagGroups: [],
          excluded: { userIds: [], modelVersionIds: [], tagGroups: [] },
        },
        postId: 4,
      } as any,
      'primary',
      'rest'
    );
    expect(m).toEqual({ ok: false, reason: 'hub:driver' });
  });

  it('refuses a second driver next to the hub', () => {
    expect(reason({ hubSources: sources, userId: 4 })).toBe('hub:driver');
    expect(reason({ hubSources: sources, ids: [4] })).toBe('hub:driver');
    expect(reason({ hubSources: sources, newCreators: true, newCreatorUserIds: [4] })).toBe(
      'hub:driver'
    );
  });

  it('still applies the filters a hub remembers', () => {
    const q = query({
      hubSources: sources,
      sort: 'Most Comments',
      period: 'Month',
      baseModels: ['Pony'],
      types: ['video'],
      excludedTagIds: [77],
    });
    expect(q?.get('sort')).toBe('comments');
    expect(q?.get('periodDays')).toBe('30');
    expect(q?.get('baseModels')).toBe('Pony');
    expect(q?.get('types')).toBe('video');
    expect(q?.get('excludedTags')).toBe('77');
    expect(reason({ hubSources: sources, remixesOnly: true })).toBe('flag:remixesOnly');
  });
});
