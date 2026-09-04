import { describe, expect, it, vi } from 'vitest';
import {
  buildFeedRequestRow,
  createFeedRequestCapture,
  parseCaptureConfig,
  type FeedCaptureConfig,
  type FeedRequestRow,
} from '../feed-request-capture.service';

const T0 = Date.UTC(2026, 8, 4, 12, 0, 0);

function harness(config: FeedCaptureConfig, opts: { random?: () => number } = {}) {
  const batches: FeedRequestRow[][] = [];
  const errors: Error[] = [];
  const capture = createFeedRequestCapture({
    getConfig: async () => config,
    insert: async (rows) => {
      batches.push(rows);
    },
    now: () => T0,
    random: opts.random ?? (() => 0),
    flushIntervalMs: 60_000,
    onError: (e) => errors.push(e),
  });
  return { capture, batches, errors };
}

const outcome = { source: 'meili', elapsedMs: 12.6, resultIds: [3, 1, 2] };

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
  it('maps the search input onto typed columns and keeps the rest as JSON', () => {
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
        signal: new AbortController().signal,
        include: ['cosmetics'],
        prioritizedUserIds: [9],
      },
      { ...outcome, nextCursor: 1725449000000 },
      T0,
      'abc123'
    );

    expect(row).toMatchObject({
      time: '2026-09-04 12:00:00.000',
      traceId: 'abc123',
      userId: 42,
      isModerator: 0,
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
      source: 'meili',
      error: 0,
      elapsedMs: 13,
      resultCount: 3,
      resultIds: [3, 1, 2],
      nextCursor: '1725449000000',
    });

    const input = JSON.parse(row.input);
    expect(input.prioritizedUserIds).toEqual([9]);
    expect(input.tags).toEqual([5132, 2539]);
    expect(input).not.toHaveProperty('user');
    expect(input).not.toHaveProperty('signal');
    expect(input).not.toHaveProperty('include');
    expect(row.input).not.toContain('private@example.com');
  });

  it('zeroes missing and non-integer numeric fields instead of sending NaN', () => {
    const row = buildFeedRequestRow({ limit: 1.5, tags: [1, 2.5, -3, 4] }, outcome, T0, '');
    expect(row.userId).toBe(0);
    expect(row.limit).toBe(0);
    expect(row.tags).toEqual([1, 4]);
    expect(row.modelId).toBe(0);
  });
});

describe('createFeedRequestCapture', () => {
  it('records nothing when the rate is 0', async () => {
    const { capture, batches } = harness({ sampleRate: 0, until: Number.POSITIVE_INFINITY });
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
    const { capture, batches } = harness({ sampleRate: 1, until: Number.POSITIVE_INFINITY });
    await capture.record({ tags: [1] }, outcome);
    await capture.record({ tags: [2] }, outcome);
    expect(batches).toEqual([]);
    await capture.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0].map((r) => r.tags)).toEqual([[1], [2]]);
    expect(capture.pending).toBe(0);
  });

  it('flushes on its own once the batch threshold is reached', async () => {
    const { capture, batches } = harness({ sampleRate: 1, until: Number.POSITIVE_INFINITY });
    for (let i = 0; i < 200; i++) await capture.record({ limit: i }, outcome);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(200);
  });

  it('drops the batch and keeps serving when the insert fails', async () => {
    const insert = vi.fn().mockRejectedValue(new Error('clickhouse down'));
    const errors: Error[] = [];
    const capture = createFeedRequestCapture({
      getConfig: async () => ({ sampleRate: 1, until: Number.POSITIVE_INFINITY }),
      insert,
      now: () => T0,
      random: () => 0,
      flushIntervalMs: 60_000,
      onError: (e) => errors.push(e),
    });
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
