import { describe, expect, it } from 'vitest';

import { shouldFlushMetricSearchIndex } from '~/server/metrics/model-metric-search-flush';

/**
 * Model-metric → search-index flush debounce.
 *
 * The processor accumulates affected model ids every minute and only drains
 * them into the search-index queue once per `intervalMs`. `shouldFlushMetricSearchIndex`
 * is the pure timing gate; a wider interval = more dedup = a smaller reindex
 * burst, at the cost of the metric-doc lagging by up to the window.
 */
describe('shouldFlushMetricSearchIndex — debounce gate', () => {
  const FIFTEEN_MIN = 15 * 60 * 1000;
  const FORTY_FIVE_MIN = 45 * 60 * 1000;

  it('does not flush before the interval has elapsed', () => {
    const lastFlush = 1_000_000;
    // one ms short of the window
    expect(
      shouldFlushMetricSearchIndex(lastFlush + FORTY_FIVE_MIN - 1, lastFlush, FORTY_FIVE_MIN)
    ).toBe(false);
  });

  it('flushes exactly at the interval boundary', () => {
    const lastFlush = 1_000_000;
    expect(
      shouldFlushMetricSearchIndex(lastFlush + FORTY_FIVE_MIN, lastFlush, FORTY_FIVE_MIN)
    ).toBe(true);
  });

  it('flushes once the interval is exceeded', () => {
    const lastFlush = 1_000_000;
    expect(
      shouldFlushMetricSearchIndex(lastFlush + FORTY_FIVE_MIN + 60_000, lastFlush, FORTY_FIVE_MIN)
    ).toBe(true);
  });

  it('honors the configured interval — a wider window suppresses a flush that a narrower one would allow', () => {
    const lastFlush = 1_000_000;
    // 20 min after the last flush: past the old 15m window, still inside a 45m window.
    const now = lastFlush + 20 * 60 * 1000;
    expect(shouldFlushMetricSearchIndex(now, lastFlush, FIFTEEN_MIN)).toBe(true);
    expect(shouldFlushMetricSearchIndex(now, lastFlush, FORTY_FIVE_MIN)).toBe(false);
  });

  it('flushes on a cold start (no prior flush recorded → lastFlush 0)', () => {
    // Mirrors the processor mapping a missing MODEL_METRIC_LAST_FLUSH key to 0.
    expect(shouldFlushMetricSearchIndex(Date.now(), 0, FORTY_FIVE_MIN)).toBe(true);
  });
});
