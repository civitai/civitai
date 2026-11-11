import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isFliptSyncMock, refreshIncMock, idsIncMock } = vi.hoisted(() => ({
  isFliptSyncMock: vi.fn(),
  refreshIncMock: vi.fn(),
  idsIncMock: vi.fn(),
}));

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { IMAGE_METRICS_SWR: 'image-metrics-swr' },
  isFliptSync: isFliptSyncMock,
  // An initialised client, so a null read does not try to start one.
  getFliptClientSync: () => ({}),
  ensureFliptInitialized: () => Promise.resolve(),
}));

// Keyed by NAME, so "which counter moved" stays answerable.
vi.mock('~/server/prom/client', () => ({
  registerCounterWithLabels: ({ name }: { name: string }) => ({
    inc:
      name === 'image_metrics_swr_refresh_total'
        ? refreshIncMock
        : name === 'image_metrics_swr_ids_total'
        ? idsIncMock
        : vi.fn(),
  }),
}));

import {
  classifyMetricHash,
  createMetricRefresher,
  imageMetricsSwrEnabled,
  resetImageMetricsSwrGateForTests,
  resolveMetricsStaleWhileRevalidate,
  SWR_MAX_STALE_SECONDS,
  SWR_POPULATED_AT_FIELD,
  SWR_REFRESH_AFTER_SECONDS,
  SWR_UNSTAMPED_REFRESH_CHANCE,
} from '../image-metrics-swr';

const EVENT_ENGINE_METRICS_SOURCE = readFileSync(
  path.resolve(__dirname, '../../../../event-engine-common/services/metrics.ts'),
  'utf8'
);

// A top-level `const NAME = <value>;` in event-engine-common/services/metrics.ts: a quoted string,
// or a product of numeric literals (`60 * 60`). Anything else fails the match, so a constant that
// moved or changed form turns this red instead of comparing against nothing.
const readMirrored = (name: string): number | string => {
  const match = new RegExp(`^const ${name} = ('[^']*'|[\\d_.\\s*]+);`, 'm').exec(
    EVENT_ENGINE_METRICS_SOURCE
  );
  expect(match, `const ${name} in event-engine-common/services/metrics.ts`).not.toBeNull();
  const value = (match as RegExpExecArray)[1].trim();
  if (value.startsWith("'")) return value.slice(1, -1);
  return value
    .split('*')
    .map((factor) => Number(factor.replace(/_/g, '').trim()))
    .reduce((product, factor) => product * factor, 1);
};

// A fixed "now" that no age constant equals, so an age computed against the wrong clock reads as
// a different class instead of happening to land on a boundary.
const NOW = 1_800_000_123;
const stamped = (ageSeconds: number, fields: Record<string, string> = {}) => ({
  ...fields,
  _populatedAt: String(NOW - ageSeconds),
});

const never = () => new Promise<never>(() => undefined);
const refreshCount = (outcome: string) =>
  refreshIncMock.mock.calls
    .filter(([labels]) => labels.outcome === outcome)
    .reduce((sum, [, n]) => sum + (n ?? 1), 0);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('classifyMetricHash', () => {
  it('classifies by the populate stamp, with both refresh boundaries exact', () => {
    // A read that did not answer is not a miss: Redis never said the key is absent.
    expect(classifyMetricHash(undefined, NOW)).toBe('unanswered');
    expect(classifyMetricHash({}, NOW)).toBe('cold');
    expect(classifyMetricHash({ Like: '3' }, NOW)).toBe('unstamped');
    expect(classifyMetricHash(stamped(0), NOW)).toBe('fresh');
    expect(classifyMetricHash(stamped(SWR_REFRESH_AFTER_SECONDS - 1), NOW)).toBe('fresh');
    expect(classifyMetricHash(stamped(SWR_REFRESH_AFTER_SECONDS), NOW)).toBe('stale');
    expect(classifyMetricHash(stamped(SWR_MAX_STALE_SECONDS - 1), NOW)).toBe('stale');
    expect(classifyMetricHash(stamped(SWR_MAX_STALE_SECONDS), NOW)).toBe('overstale');
    // A notFound sentinel is a cached answer ("no rows"), not a miss.
    expect(classifyMetricHash(stamped(10, { notFound: '1' }), NOW)).toBe('fresh');
  });

  it('mirrors event-engine-common: the same refresh age, unstamped share and stamp field', () => {
    // Read from the submodule's source: it does not export these. A missing constant fails here
    // rather than skipping (`readMirrored` asserts the match).
    expect(SWR_REFRESH_AFTER_SECONDS).toBe(readMirrored('REFRESH_AFTER'));
    expect(SWR_UNSTAMPED_REFRESH_CHANCE).toBe(readMirrored('UNSTAMPED_REFRESH_CHANCE'));
    expect(SWR_POPULATED_AT_FIELD).toBe(readMirrored('POPULATED_AT_FIELD'));
  });

  it('bounds the max staleness between the refresh age and the 12h TTL', () => {
    expect(SWR_MAX_STALE_SECONDS).toBeGreaterThan(SWR_REFRESH_AFTER_SECONDS);
    expect(SWR_MAX_STALE_SECONDS).toBeLessThan(12 * 60 * 60);
  });
});

describe('resolveMetricsStaleWhileRevalidate', () => {
  const shape = (id: number, hash: Record<string, string>) => ({ id, like: Number(hash.Like) });

  it('serves a STALE value without awaiting its refresh', async () => {
    // The refresh never settles: if the read awaited it, this case would hang, not fail on a value.
    const refresh = vi.fn(never);
    const refresher = createMetricRefresher(refresh, { flushMs: 10_000 });
    const fetchCold = vi.fn(async () => ({}));

    const result = await resolveMetricsStaleWhileRevalidate([7], {
      readHashes: async () => [stamped(SWR_REFRESH_AFTER_SECONDS + 17, { Like: '41' })],
      shape,
      fetchCold,
      enqueueRefresh: refresher.enqueue,
      nowSeconds: () => NOW,
    });

    expect(result).toEqual({ 7: { id: 7, like: 41 } });
    // Never read through the request path once a value exists.
    expect(fetchCold).not.toHaveBeenCalled();
    // And it WAS handed to the refresher - otherwise "served without awaiting" also passes on an
    // implementation that never refreshes at all.
    expect(refresher.stats().pending).toBe(1);
    refresher.flushNow();
    expect(refresh).toHaveBeenCalledWith([7]);
  });

  it('does not refresh a FRESH value', async () => {
    const enqueueRefresh = vi.fn();
    const result = await resolveMetricsStaleWhileRevalidate([5], {
      readHashes: async () => [stamped(60, { Like: '9' })],
      shape,
      fetchCold: vi.fn(async () => ({})),
      enqueueRefresh,
      nowSeconds: () => NOW,
    });
    expect(result[5]).toEqual({ id: 5, like: 9 });
    expect(enqueueRefresh).not.toHaveBeenCalled();
  });

  it('reads COLD, UNANSWERED and OVER-STALE ids the old way, awaited, and only those', async () => {
    const fetchCold = vi.fn(async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, like: 1000 + id }]))
    );
    const enqueueRefresh = vi.fn();

    const result = await resolveMetricsStaleWhileRevalidate([1, 2, 3, 2, 6], {
      readHashes: async (ids) => {
        // De-duplicated before the read, in first-seen order.
        expect(ids).toEqual([1, 2, 3, 6]);
        return [stamped(5, { Like: '11' }), {}, stamped(SWR_MAX_STALE_SECONDS + 1), undefined];
      },
      shape,
      fetchCold,
      enqueueRefresh,
      nowSeconds: () => NOW,
    });

    expect(fetchCold).toHaveBeenCalledTimes(1);
    expect(fetchCold).toHaveBeenCalledWith([2, 3, 6]);
    expect(result).toEqual({
      1: { id: 1, like: 11 },
      2: { id: 2, like: 1002 },
      3: { id: 3, like: 1003 },
      6: { id: 6, like: 1006 },
    });
    // Over-stale is the old path's to refresh, not the background refresher's.
    expect(enqueueRefresh).not.toHaveBeenCalled();
    // One per class, each its own label value: a slow Redis (unanswered) must not read as a
    // cache miss (cold) on the counter.
    expect(idsIncMock.mock.calls).toEqual(
      expect.arrayContaining([
        [{ class: 'fresh' }, 1],
        [{ class: 'cold' }, 1],
        [{ class: 'unanswered' }, 1],
        [{ class: 'overstale' }, 1],
      ])
    );
    expect(idsIncMock).toHaveBeenCalledTimes(4);
  });

  it('refreshes an UNSTAMPED entry only on the sampled share of reads', async () => {
    const run = async (roll: number) => {
      const enqueueRefresh = vi.fn();
      await resolveMetricsStaleWhileRevalidate([4], {
        readHashes: async () => [{ Like: '2' }],
        shape,
        fetchCold: vi.fn(async () => ({})),
        enqueueRefresh,
        nowSeconds: () => NOW,
        random: () => roll,
      });
      return enqueueRefresh.mock.calls.length;
    };
    expect(await run(0.01)).toBe(1);
    expect(await run(0.5)).toBe(0);
  });

  it('keeps the answer when the refresher throws', async () => {
    const result = await resolveMetricsStaleWhileRevalidate([8], {
      readHashes: async () => [stamped(SWR_REFRESH_AFTER_SECONDS + 1, { Like: '6' })],
      shape,
      fetchCold: vi.fn(async () => ({})),
      enqueueRefresh: () => {
        throw new Error('refresher fault');
      },
      nowSeconds: () => NOW,
    });
    expect(result[8]).toEqual({ id: 8, like: 6 });
  });
});

describe('createMetricRefresher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('de-duplicates an id that is queued, then in flight, into ONE refresh', async () => {
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => (finish = () => resolve())));
    const refresher = createMetricRefresher(refresh, { flushMs: 10_000 });

    // Three requests offer the same id before the batch runs.
    refresher.enqueue([42]);
    refresher.enqueue([42]);
    refresher.enqueue([42, 43]);
    refresher.flushNow();
    // And two more while it is in flight.
    refresher.enqueue([42]);
    refresher.enqueue([43]);
    refresher.flushNow();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith([42, 43]);
    expect(refreshCount('queued')).toBe(2);
    expect(refreshCount('deduped')).toBe(4);

    finish();
    await vi.waitFor(() => expect(refresher.stats().running).toBe(0));
    expect(refreshCount('batch_ok')).toBe(1);
  });

  it('does not re-offer an id inside its cooldown, and does after it', async () => {
    let clock = 1_000_000;
    const refresh = vi.fn(async () => undefined);
    const refresher = createMetricRefresher(refresh, {
      flushMs: 10_000,
      cooldownMs: 60_000,
      now: () => clock,
    });

    refresher.enqueue([9]);
    refresher.flushNow();
    await vi.waitFor(() => expect(refresher.stats().running).toBe(0));

    clock += 59_000;
    refresher.enqueue([9]);
    refresher.flushNow();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refreshCount('cooldown')).toBe(1);

    clock += 2_000;
    refresher.enqueue([9]);
    refresher.flushNow();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('runs at most maxConcurrent refreshes, and starts the next when one finishes', async () => {
    const finishers: (() => void)[] = [];
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishers.push(() => resolve());
        })
    );
    const refresher = createMetricRefresher(refresh, {
      flushMs: 0,
      batchSize: 1,
      maxConcurrent: 2,
    });

    // A spike: five distinct stale ids at once.
    refresher.enqueue([1, 2, 3, 4, 5]);
    refresher.flushNow();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresher.stats()).toMatchObject({ running: 2, pending: 3, inFlight: 2 });

    // Still capped when more arrive.
    refresher.enqueue([6]);
    refresher.flushNow();
    expect(refresh).toHaveBeenCalledTimes(2);

    finishers[0]();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
    expect(refresher.stats().running).toBe(2);
  });

  it('starts the next FULL batch as soon as a slot frees, without waiting for the timer', async () => {
    const finishers: (() => void)[] = [];
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishers.push(() => resolve());
        })
    );
    // A flush window far longer than the wait below: if the freed slot re-armed the timer, the
    // second batch could not start inside this test.
    const refresher = createMetricRefresher(refresh, {
      flushMs: 60_000,
      batchSize: 2,
      maxConcurrent: 1,
    });

    refresher.enqueue([1, 2, 3, 4, 5]);
    refresher.flushNow();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenLastCalledWith([1, 2]);

    // Three waiting >= batchSize: the next batch starts the moment the slot frees.
    finishers[0]();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    expect(refresh).toHaveBeenLastCalledWith([3, 4]);

    // CONTROL: one waiting < batchSize, so it keeps coalescing until the timer instead.
    finishers[1]();
    await vi.waitFor(() => expect(refresher.stats().running).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresher.stats().pending).toBe(1);
  });

  it('drops ids past maxPending instead of growing without bound', () => {
    const refresher = createMetricRefresher(vi.fn(never), { flushMs: 10_000, maxPending: 3 });
    refresher.enqueue([1, 2, 3, 4, 5]);
    expect(refresher.stats().pending).toBe(3);
    expect(refreshCount('dropped')).toBe(2);
  });

  it('batches ids offered within one flush window into one refresh', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const refresher = createMetricRefresher(refresh, { flushMs: 1_000, batchSize: 200 });

    refresher.enqueue([1, 2]);
    refresher.enqueue([3]);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('counts a failed refresh and frees its slot', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('clickhouse down');
    });
    const refresher = createMetricRefresher(refresh, { flushMs: 10_000 });
    refresher.enqueue([1]);
    refresher.flushNow();
    await vi.waitFor(() => expect(refresher.stats().running).toBe(0));
    expect(refreshCount('batch_error')).toBe(1);
    expect(refresher.stats().inFlight).toBe(0);
  });
});

describe('imageMetricsSwrEnabled', () => {
  beforeEach(() => {
    isFliptSyncMock.mockReset();
    resetImageMetricsSwrGateForTests();
  });

  it('is OFF when the flag is off, unknown, or the read throws', () => {
    isFliptSyncMock.mockReturnValue(false);
    expect(imageMetricsSwrEnabled()).toBe(false);
    resetImageMetricsSwrGateForTests();
    isFliptSyncMock.mockReturnValue(null);
    expect(imageMetricsSwrEnabled()).toBe(false);
    resetImageMetricsSwrGateForTests();
    isFliptSyncMock.mockImplementation(() => {
      throw new Error('flipt down');
    });
    expect(imageMetricsSwrEnabled()).toBe(false);
  });

  it('is ON only when the flag says so, read under its own key', () => {
    isFliptSyncMock.mockReturnValue(true);
    expect(imageMetricsSwrEnabled()).toBe(true);
    expect(isFliptSyncMock).toHaveBeenCalledWith('image-metrics-swr');
  });
});
