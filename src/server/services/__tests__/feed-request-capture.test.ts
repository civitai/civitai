import { describe, expect, it, vi } from 'vitest';
import {
  buildFeedRequestRow,
  createFeedRequestCapture,
  MAX_BUFFERED_ROWS,
  parseCaptureConfig,
  type FeedCaptureConfig,
  type FeedRequestRow,
} from '../feed-request-capture.service';

const T0 = Date.UTC(2026, 8, 4, 12, 0, 0);
const ALWAYS: FeedCaptureConfig = { sampleRate: 1, until: Number.POSITIVE_INFINITY };

function harness(
  config: FeedCaptureConfig,
  opts: { random?: () => number; insert?: (rows: FeedRequestRow[]) => Promise<void> } = {}
) {
  const batches: FeedRequestRow[][] = [];
  const errors: Error[] = [];
  const capture = createFeedRequestCapture({
    getConfig: async () => config,
    insert:
      opts.insert ??
      (async (rows) => {
        batches.push(rows);
      }),
    now: () => T0,
    random: opts.random ?? (() => 0.5),
    flushIntervalMs: 60_000,
    onError: (e) => errors.push(e),
  });
  return { capture, batches, errors };
}

const outcome = { source: 'getImagesFromSearch' as const, elapsedMs: 12.6, resultIds: [3, 1, 2] };

describe('parseCaptureConfig', () => {
  it('is off when the hash is missing, empty, or malformed', () => {
    expect(parseCaptureConfig(null).sampleRate).toBe(0);
    expect(parseCaptureConfig({}).sampleRate).toBe(0);
    expect(parseCaptureConfig({ sampleRate: 'yes' }).sampleRate).toBe(0);
  });

  it('clamps the rate and reads until as ISO or epoch ms', () => {
    expect(parseCaptureConfig({ sampleRate: '7' }).sampleRate).toBe(1);
    expect(parseCaptureConfig({ sampleRate: '-1' }).sampleRate).toBe(0);
    expect(parseCaptureConfig({ sampleRate: '0.25' })).toEqual({
      sampleRate: 0.25,
      until: Number.POSITIVE_INFINITY,
    });
    expect(parseCaptureConfig({ sampleRate: '1', until: '2026-09-04T12:00:00Z' }).until).toBe(T0);
    expect(parseCaptureConfig({ sampleRate: '1', until: String(T0) }).until).toBe(T0);
  });

  it('disables capture when until cannot be parsed', () => {
    expect(parseCaptureConfig({ sampleRate: '1', until: 'tomorrow' }).until).toBe(0);
  });
});

describe('buildFeedRequestRow', () => {
  it('maps the search input onto typed columns and keeps the allowlisted rest as JSON', () => {
    const row = buildFeedRequestRow(
      {
        currentUserId: 42,
        isModerator: false,
        sort: 'Most Reactions',
        period: 'Week',
        browsingLevel: 31,
        limit: 100,
        cursor: '1725450000000|123',
        tags: [5132, 2539],
        excludedTagIds: [111991],
        modelVersionId: 290640,
        userId: 7,
        types: ['image', 'video'],
        withMeta: true,
        followed: false,
        user: { id: 42, email: 'private@example.com' },
        username: 'a-real-username',
        signal: new AbortController().signal,
        include: ['cosmetics'],
        headers: { src: 'getInfiniteImagesHandler' },
        prioritizedUserIds: [9],
        someFieldAddedLater: 'phone:+15551234567',
      },
      { ...outcome, filterMode: 'post', nextCursor: 1725449000000 },
      T0,
      'abc123'
    );

    expect(row).toMatchObject({
      time: '2026-09-04 12:00:00.000',
      traceId: 'abc123',
      userId: 42,
      isModerator: 0,
      source: 'getImagesFromSearch',
      callSite: 'getInfiniteImagesHandler',
      filterMode: 'post',
      sort: 'Most Reactions',
      period: 'Week',
      browsingLevel: 31,
      limit: 100,
      cursor: '1725450000000|123',
      tags: [5132, 2539],
      excludedTagIds: [111991],
      modelVersionId: 290640,
      filterUserId: 7,
      types: ['image', 'video'],
      flags: ['withMeta'],
      error: 0,
      elapsedMs: 13,
      resultCount: 3,
      resultIds: [3, 1, 2],
      nextCursor: '1725449000000',
    });

    const input = JSON.parse(row.input);
    expect(input.prioritizedUserIds).toEqual([9]);
    expect(input.tags).toEqual([5132, 2539]);
    for (const key of ['user', 'username', 'signal', 'include', 'headers', 'someFieldAddedLater'])
      expect(input).not.toHaveProperty(key);
    expect(row.input).not.toContain('private@example.com');
    expect(row.input).not.toContain('+15551234567');
    expect(row.input).not.toContain('a-real-username');
  });

  it('is an allowlist — a key that is not named is not captured', () => {
    const row = buildFeedRequestRow({ tags: [1], newKeyNobodyReviewed: 'x' }, outcome, T0, '');
    expect(JSON.parse(row.input)).toEqual({ tags: [1] });
  });

  it('clamps numeric columns to their ClickHouse widths instead of failing the batch', () => {
    const row = buildFeedRequestRow(
      { browsingLevel: 70_000, limit: 1.5, tags: [1, 2.5, -3, 4, 5_000_000_000] },
      { ...outcome, elapsedMs: -4, resultIds: Array.from({ length: 70_000 }, (_, i) => i) },
      T0,
      ''
    );
    expect(row.browsingLevel).toBe(65_535);
    expect(row.limit).toBe(0);
    expect(row.tags).toEqual([1, 4]);
    expect(row.userId).toBe(0);
    expect(row.modelId).toBe(0);
    expect(row.elapsedMs).toBe(0);
    expect(row.resultCount).toBe(65_535);
  });

  it('labels the db branch and leaves filterMode empty there', () => {
    const row = buildFeedRequestRow({}, { ...outcome, source: 'getAllImages' }, T0, '');
    expect(row.source).toBe('getAllImages');
    expect(row.filterMode).toBe('');
    expect(row.callSite).toBe('');
  });
});

describe('createFeedRequestCapture', () => {
  it('records nothing when the rate is 0, even when the draw would pass', async () => {
    const { capture, batches } = harness(
      { sampleRate: 0, until: Number.POSITIVE_INFINITY },
      { random: () => 0 }
    );
    await capture.record({}, outcome);
    await capture.flush();
    expect(batches).toEqual([]);
    expect(capture.pending).toBe(0);
  });

  it('records nothing once until has passed', async () => {
    const { capture, batches } = harness({ sampleRate: 1, until: T0 - 1 });
    await capture.record({}, outcome);
    await capture.flush();
    expect(batches).toEqual([]);
  });

  it('samples against the configured rate', async () => {
    const draws = [0.1, 0.9, 0.3];
    const { capture } = harness(
      { sampleRate: 0.5, until: Number.POSITIVE_INFINITY },
      { random: () => draws.shift() ?? 1 }
    );
    await capture.record({}, outcome);
    await capture.record({}, outcome);
    await capture.record({}, outcome);
    expect(capture.pending).toBe(2);
  });

  it('buffers rows and inserts them as one batch on flush', async () => {
    const { capture, batches } = harness(ALWAYS);
    await capture.record({ tags: [1] }, outcome);
    await capture.record({ tags: [2] }, outcome);
    expect(batches).toEqual([]);
    await capture.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0].map((r) => r.tags)).toEqual([[1], [2]]);
    expect(capture.pending).toBe(0);
  });

  it('flushes on its own once the batch threshold is reached', async () => {
    const { capture, batches } = harness(ALWAYS);
    for (let i = 0; i < 200; i++) await capture.record({ limit: i }, outcome);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(200);
  });

  it('flushes on the timer when the threshold is not reached', async () => {
    vi.useFakeTimers();
    try {
      const batches: FeedRequestRow[][] = [];
      const capture = createFeedRequestCapture({
        getConfig: async () => ALWAYS,
        insert: async (rows) => {
          batches.push(rows);
        },
        now: () => T0,
        random: () => 0.5,
        flushIntervalMs: 2_000,
      });
      await capture.record({}, outcome);
      expect(batches).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(batches).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one insert in flight, buffers behind it, and sheds beyond the cap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const batches: FeedRequestRow[][] = [];
    const { capture } = harness(ALWAYS, {
      insert: async (rows) => {
        batches.push(rows);
        if (batches.length === 1) await gate;
      },
    });
    for (let i = 0; i < 200; i++) await capture.record({ limit: i }, outcome);
    expect(batches).toHaveLength(1);

    const extra = 50;
    for (let i = 0; i < MAX_BUFFERED_ROWS + extra; i++) await capture.record({ limit: i }, outcome);
    expect(batches).toHaveLength(1);
    expect(capture.pending).toBe(MAX_BUFFERED_ROWS);
    expect(capture.dropped).toBe(extra);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await capture.flush();
    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(MAX_BUFFERED_ROWS);
    expect(capture.pending).toBe(0);
  });

  it('drops the batch and keeps serving when the insert fails', async () => {
    const insert = vi.fn().mockRejectedValue(new Error('clickhouse down'));
    const { capture, errors } = harness(ALWAYS, { insert });
    await capture.record({}, outcome);
    await capture.flush();
    expect(errors.map((e) => e.message)).toEqual(['clickhouse down']);
    expect(capture.pending).toBe(0);

    await capture.record({}, outcome);
    expect(capture.pending).toBe(1);
  });

  it('never throws to the caller when the config read fails', async () => {
    const capture = createFeedRequestCapture({
      getConfig: async () => {
        throw new Error('redis down');
      },
      insert: async () => undefined,
    });
    await expect(capture.record({}, outcome)).resolves.toBeUndefined();
    expect(capture.pending).toBe(0);
  });
});
