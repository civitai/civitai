import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildFeedShadowRow,
  compareIds,
  createFeedShadow,
  mapSearchInputToFeedQuery,
  parseShadowConfig,
  type FeedShadowConfig,
  type FeedShadowRow,
} from '../feed-shadow.service';

const T0 = Date.UTC(2026, 8, 9, 12, 0, 0);
const ALWAYS: FeedShadowConfig = { sampleRate: 1, until: Number.POSITIVE_INFINITY, timeoutMs: 1000, maxInflight: 2 };
const outcome = { source: 'getImagesFromSearch' as const, elapsedMs: 12, resultIds: [3, 1, 2] };
const base = { sort: 'Most Reactions', period: 'Week', browsingLevel: 31, limit: 100 };

describe('parseShadowConfig', () => {
  it('is off when missing and clamps the knobs', () => {
    expect(parseShadowConfig(null).sampleRate).toBe(0);
    expect(parseShadowConfig({ sampleRate: '0.05', timeoutMs: '99999', maxInflight: '0' })).toEqual({
      sampleRate: 0.05,
      until: Number.POSITIVE_INFINITY,
      timeoutMs: 10_000,
      maxInflight: 32,
    });
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
    expect(q.get('before')).toBe('1788000000000');
  });

  it('names the first thing it cannot express', () => {
    const reason = (i: Record<string, unknown>) => {
      const m = mapSearchInputToFeedQuery({ ...base, ...i });
      return m.ok ? 'ok' : m.reason;
    };
    expect(reason({ followed: true })).toBe('flag:followed');
    expect(reason({ postId: 4 })).toBe('input:postId');
    expect(reason({ modelId: 4 })).toBe('modelId');
    expect(reason({ cursor: '30000|1788000000000' })).toBe('offset>20000');
    expect(reason({ sort: 'Random' })).toBe('sort:Random');
    expect(reason({ notPublished: true })).toBe('flag:unpublished:no-user');
    expect(reason({ notPublished: true, userId: 3 })).toBe('ok');
  });
});

describe('compareIds', () => {
  it('measures overlap, top-10 overlap and the first order break', () => {
    expect(compareIds([1, 2, 3, 4], [1, 2, 4, 9])).toEqual({ overlap: 0.75, overlapTop10: 0.75, firstMismatch: 2 });
    expect(compareIds([1, 2], [1, 2, 3])).toEqual({ overlap: 1, overlapTop10: 1, firstMismatch: -1 });
    expect(compareIds([], [])).toEqual({ overlap: 1, overlapTop10: 1, firstMismatch: -1 });
    expect(compareIds([], [5]).overlap).toBe(0);
  });
});

describe('feedShadow row ↔ DDL parity', () => {
  it('writes exactly the columns the table declares', () => {
    const sql = readFileSync(path.resolve(__dirname, '../../clickhouse/migrations/2026-09-09-feed-shadow.sql'), 'utf8');
    const body = sql.slice(sql.indexOf('feedShadow\n(') + 'feedShadow\n('.length, sql.indexOf('\n)\nENGINE'));
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
  function harness(config: FeedShadowConfig, fetchFeed = async () => ({ status: 200, ms: 5, ids: [3, 1, 9], route: 'r', estimate: 1, candidates: 2 })) {
    const batches: FeedShadowRow[][] = [];
    const shadow = createFeedShadow({
      getConfig: async () => config,
      fetchFeed,
      insert: async (rows) => {
        batches.push(rows);
      },
      now: () => T0,
      random: () => 0.5,
      flushIntervalMs: 60_000,
      onError: () => undefined,
    });
    return { shadow, batches };
  }

  it('records the comparison and never throws', async () => {
    const { shadow, batches } = harness(ALWAYS);
    await shadow.compare(base, outcome);
    await shadow.flush();
    expect(batches).toHaveLength(1);
    const row = batches[0][0];
    expect(row.skipReason).toBe('');
    expect(row.feedIds).toEqual([3, 1, 9]);
    expect(row.overlap).toBeCloseTo(2 / 3);
    expect(row.firstMismatch).toBe(2);
    expect(row.error).toBe(0);
  });

  it('records skipped shapes without calling the feed', async () => {
    let calls = 0;
    const { shadow, batches } = harness(ALWAYS, async () => {
      calls++;
      return { status: 200, ms: 1, ids: [] };
    });
    await shadow.compare({ ...base, followed: true }, outcome);
    await shadow.flush();
    expect(calls).toBe(0);
    expect(batches[0][0].skipReason).toBe('flag:followed');
  });

  it('drops when the inflight cap is reached and counts a timeout as an error row', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { shadow, batches } = harness(ALWAYS, async () => {
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
    await shadow.flush();
    expect(shadow.dropped).toBe(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0][0].feedStatus).toBe(504);
    expect(batches[0][0].error).toBe(1);
  });

  it('does nothing when off', async () => {
    const { shadow, batches } = harness({ ...ALWAYS, sampleRate: 0 });
    await shadow.compare(base, outcome);
    await shadow.flush();
    expect(batches).toHaveLength(0);
  });
});
