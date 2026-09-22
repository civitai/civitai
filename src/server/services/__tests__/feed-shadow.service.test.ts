import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  buildFeedShadowRow,
  compareIds,
  createFeedShadow,
  encodeFeedCursor,
  mapSearchInputToFeedQuery,
  parseFeedCursor,
  parseShadowConfig,
  type FeedShadowConfig,
  fetchFeedAnswer,
} from '../feed-shadow.service';
import type { FeedShadowRow } from '~/server/common/feed-shadow.constants';

const T0 = Date.UTC(2026, 8, 9, 12, 0, 0);
const ALWAYS: FeedShadowConfig = {
  sampleRate: 1,
  until: Number.POSITIVE_INFINITY,
  timeoutMs: 1000,
  maxInflight: 2,
};
const outcome = { source: 'getImagesFromSearch' as const, elapsedMs: 12, resultIds: [3, 1, 2] };
const base = { sort: 'Most Reactions', period: 'Week', browsingLevel: 31, limit: 100 };

describe('parseShadowConfig', () => {
  it('is off when missing and clamps the knobs', () => {
    expect(parseShadowConfig(null).sampleRate).toBe(0);
    expect(parseShadowConfig({ sampleRate: '0.05', timeoutMs: '99999', maxInflight: '0' })).toEqual(
      {
        sampleRate: 0.05,
        until: Number.POSITIVE_INFINITY,
        timeoutMs: 10_000,
        maxInflight: 32,
      }
    );
  });
});

describe('fetchFeedAnswer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the active trace context so the feed joins the request trace', async () => {
    const provider = new NodeTracerProvider();
    provider.register();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
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
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
    expect(headers['x-request-source']).toBe('primary');
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
    expect(reason({ followed: true })).toBe('flag:followed');
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

  it('serves a follow feed only from a resolved follow list the feed can take', () => {
    const m = mapSearchInputToFeedQuery({ ...base, followed: true, followedUserIds: [7, 3, 0] });
    expect(m.ok && new URLSearchParams(m.query).get('userIds')).toBe('7,3');
    const reason = (i: Record<string, unknown>) => {
      const r = mapSearchInputToFeedQuery({ ...base, followed: true, ...i });
      return r.ok ? 'ok' : r.reason;
    };
    expect(reason({})).toBe('flag:followed');
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

describe('compareIds', () => {
  it('measures overlap, top-10 overlap and the first order break', () => {
    expect(compareIds([1, 2, 3, 4], [1, 2, 4, 9])).toEqual({
      overlap: 0.75,
      overlapTop10: 0.75,
      firstMismatch: 2,
    });
    expect(compareIds([1, 2], [1, 2, 3])).toEqual({
      overlap: 1,
      overlapTop10: 1,
      firstMismatch: -1,
    });
    expect(compareIds([], [])).toEqual({ overlap: 1, overlapTop10: 1, firstMismatch: -1 });
    expect(compareIds([], [5]).overlap).toBe(0);
  });
});

describe('feedShadow row ↔ DDL parity', () => {
  it('writes exactly the columns the table declares', () => {
    const sql = readFileSync(
      path.resolve(__dirname, '../../clickhouse/migrations/2026-09-09-feed-shadow.sql'),
      'utf8'
    );
    const body = sql.slice(
      sql.indexOf('feedShadow\n(') + 'feedShadow\n('.length,
      sql.indexOf('\n)\nENGINE')
    );
    const columns = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
      .map((l) => l.split(/\s+/)[0]);
    const row = buildFeedShadowRow({}, outcome, T0, '', { ok: false, reason: 'x' });
    expect(new Set(Object.keys(row))).toEqual(new Set(columns));
  });
});

describe('createFeedShadow', () => {
  function harness(
    config: FeedShadowConfig,
    fetchFeed = async () => ({
      status: 200,
      ms: 5,
      ids: [3, 1, 9],
      route: 'r',
      estimate: 1,
      candidates: 2,
    })
  ) {
    const rows: FeedShadowRow[] = [];
    const shadow = createFeedShadow({
      getConfig: async () => config,
      fetchFeed,
      record: async (row) => {
        rows.push(row);
      },
      now: () => T0,
      random: () => 0.5,
      onError: () => undefined,
    });
    return { shadow, rows };
  }

  it('records the comparison and never throws', async () => {
    const { shadow, rows } = harness(ALWAYS);
    await shadow.compare(base, outcome);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.skipReason).toBe('');
    expect(row.feedIds).toEqual([3, 1, 9]);
    expect(row.overlap).toBeCloseTo(2 / 3);
    expect(row.firstMismatch).toBe(2);
    expect(row.error).toBe(0);
  });

  it('records skipped shapes without calling the feed', async () => {
    let calls = 0;
    const { shadow, rows } = harness(ALWAYS, async () => {
      calls++;
      return { status: 200, ms: 1, ids: [] };
    });
    await shadow.compare({ ...base, followed: true }, outcome);
    expect(calls).toBe(0);
    expect(rows[0].skipReason).toBe('flag:followed');
  });

  it('drops when the inflight cap is reached and counts a timeout as an error row', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { shadow, rows } = harness(ALWAYS, async () => {
      await gate;
      const err = new Error('t');
      err.name = 'TimeoutError';
      throw err;
    });
    const a = shadow.compare(base, outcome);
    const b = shadow.compare(base, outcome);
    const c = shadow.compare(base, outcome);
    await new Promise((r) => setTimeout(r, 0));
    expect(shadow.inflight).toBe(2);
    release();
    await Promise.all([a, b, c]);
    expect(shadow.dropped).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows[0].feedStatus).toBe(504);
    expect(rows[0].error).toBe(1);
  });

  it('does nothing when off', async () => {
    const { shadow, rows } = harness({ ...ALWAYS, sampleRate: 0 });
    await shadow.compare(base, outcome);
    expect(rows).toHaveLength(0);
  });
});
