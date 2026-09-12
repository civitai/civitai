import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit coverage for the ClickHouse-backed windowed collection ranking.
 *
 * The two things worth pinning here are the ones a reader cannot check by eye:
 * WHICH WINDOW each period resolves to (a date literal that has to be exact, not
 * "a date"), and WHAT HAPPENS WHEN THE STORE IS ABSENT — the `clickhouse ===
 * undefined` branch, which is a normal deployment state rather than an error and
 * must be reported as such rather than silently returning nothing.
 *
 * The clock is frozen because every assertion in the window block is a claim about
 * a date arithmetic result. Without a freeze these tests pass on most days and go
 * red at a month or year boundary, which is the worst possible failure mode: a
 * flake that is actually correct.
 */

const { mockQuery, clickhouseBox } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  clickhouseBox: { client: undefined as unknown },
}));

// A GETTER, not a value: the module binding has to be re-read per call so a test
// can flip the client to `undefined` mid-suite and exercise the disabled branch.
vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return clickhouseBox.client;
  },
}));
// `~/server/logging/client` is NOT mocked here on purpose: `src/__tests__/setup.ts`
// registers the canonical mock for it worker-wide (only `logToAxiom` is stubbed, so
// the module's other six exports stay real). A per-file `vi.mock` of a canonical
// specifier freezes this file's shape into every later file in the same worker —
// which is exactly what `no-direct-shared-module-mock` exists to stop.

import {
  CH_RANKING_DEPTH,
  CH_RANKING_MAX_ATTEMPTS,
  CH_RANKING_RETRY_BUDGET_MS,
  PERIOD_WINDOW_DAYS,
  getWindowedCollectionRanking,
  isWindowedPeriod,
  windowStartDate,
} from '~/server/services/blocks/block-collection-popularity.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

/** 2026-09-11T12:00:00Z — mid-day, mid-month, so no boundary flatters the maths. */
const NOW = new Date('2026-09-11T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  clickhouseBox.client = { $query: mockQuery };
  mockQuery.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isWindowedPeriod', () => {
  it('is true for exactly the four ClickHouse-servable periods', () => {
    expect(isWindowedPeriod(MetricTimeframe.Day)).toBe(true);
    expect(isWindowedPeriod(MetricTimeframe.Week)).toBe(true);
    expect(isWindowedPeriod(MetricTimeframe.Month)).toBe(true);
    expect(isWindowedPeriod(MetricTimeframe.Year)).toBe(true);
  });

  it('is false for AllTime — history begins 2025-11-06, so ClickHouse cannot answer it', () => {
    expect(isWindowedPeriod(MetricTimeframe.AllTime)).toBe(false);
  });

  it('is false for an absent period', () => {
    expect(isWindowedPeriod(undefined)).toBe(false);
  });
});

describe('windowStartDate', () => {
  /**
   * The exact literal, per period, against a frozen clock. Asserting the STRING is
   * the point: a test that only checked "the SQL contains a date" would pass with
   * every period resolving to the same window, which is precisely the bug a
   * windowed feature can ship with and nobody notices.
   */
  it.each([
    [MetricTimeframe.Day, '2026-09-10'],
    [MetricTimeframe.Week, '2026-09-04'],
    [MetricTimeframe.Month, '2026-08-12'],
    [MetricTimeframe.Year, '2025-09-11'],
  ])('%s resolves to %s', (period, expected) => {
    expect(windowStartDate(period as never, NOW)).toBe(expected);
  });

  it('the four windows are all DIFFERENT — no two periods share a bound', () => {
    const bounds = (
      [
        MetricTimeframe.Day,
        MetricTimeframe.Week,
        MetricTimeframe.Month,
        MetricTimeframe.Year,
      ] as const
    ).map((p) => windowStartDate(p, NOW));
    expect(new Set(bounds).size).toBe(4);
  });

  it('defaults `now` to the current clock', () => {
    expect(windowStartDate(MetricTimeframe.Day)).toBe('2026-09-10');
  });

  it('the bound is inclusive of the seal lag — Day reaches yesterday, not only today', () => {
    // The daily aggregate seals late: measured 2026-09-11, the newest `day` present
    // for Collection/followerCount was 2026-09-10. An exclusive "today only" bound
    // would therefore return an empty Day window for most of every day.
    expect(PERIOD_WINDOW_DAYS[MetricTimeframe.Day]).toBe(1);
    expect(windowStartDate(MetricTimeframe.Day, NOW) < NOW.toISOString().slice(0, 10)).toBe(true);
  });
});

describe('getWindowedCollectionRanking', () => {
  it('queries the HISTORY table, sums the per-day delta, and bounds the window', async () => {
    await getWindowedCollectionRanking({ period: MetricTimeframe.Month, now: NOW });
    const sql = mockQuery.mock.calls[0][0] as string;
    // The history table, not `entityMetricDailyAgg_v2` — the latter holds only the
    // current day and reads exactly like "there is no history here".
    expect(sql).toContain('entityMetricDailyAgg_history_v2');
    // `total` is a PER-DAY DELTA, so a window is a SUM, never a latest-row read.
    expect(sql).toContain('sum(total)');
    expect(sql).toContain("toDate('2026-08-12')");
    expect(sql).toContain("entityType = 'Collection'");
    expect(sql).toContain("metricType = 'followerCount'");
    expect(sql).toContain(`LIMIT ${CH_RANKING_DEPTH}`);
  });

  it('breaks ties on entityId so offset pagination sees one total order', async () => {
    await getWindowedCollectionRanking({ period: MetricTimeframe.Week, now: NOW });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY sum(total) DESC, entityId DESC');
  });

  it.each([
    [MetricTimeframe.Day, '2026-09-10'],
    [MetricTimeframe.Week, '2026-09-04'],
    [MetricTimeframe.Month, '2026-08-12'],
    [MetricTimeframe.Year, '2025-09-11'],
  ])('%s sends its own window bound (%s) to ClickHouse', async (period, expected) => {
    await getWindowedCollectionRanking({ period: period as never, now: NOW });
    expect(mockQuery.mock.calls[0][0] as string).toContain(`toDate('${expected}')`);
  });

  it('returns the ids in the order ClickHouse ranked them', async () => {
    mockQuery.mockResolvedValueOnce([{ id: 7 }, { id: 3 }, { id: 91 }]);
    const result = await getWindowedCollectionRanking({ period: MetricTimeframe.Month, now: NOW });
    expect(result).toEqual({ ids: [7, 3, 91], source: 'clickhouse' });
  });

  it('reports `clickhouse-disabled` when the client is undefined — it does NOT query', async () => {
    // The real shape of this: `shouldConnect` is false without CLICKHOUSE_HOST /
    // CLICKHOUSE_USERNAME, and during a Next build. A deployment without the
    // analytics store is not broken, and must not be answered with an empty grid.
    clickhouseBox.client = undefined;
    const result = await getWindowedCollectionRanking({ period: MetricTimeframe.Month, now: NOW });
    expect(result).toEqual({ ids: null, source: 'unavailable', reason: 'clickhouse-disabled' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // 🔴 `mockRejectedValue`, NOT `mockRejectedValueOnce`, in every test below that means
  // "the query throws". A single-shot rejection no longer degrades — the retry catches
  // it — so a `…Once` here would silently become a test of the SECOND call's default
  // resolution. Both of these were `…Once` until the retry shipped, and one of them then
  // passed for the wrong reason (`{ ids: [] }` is also `!==` the disabled result).
  it('reports `clickhouse-error` when EVERY attempt throws, rather than propagating', async () => {
    mockQuery.mockRejectedValue(new Error('connection reset'));
    const result = await getWindowedCollectionRanking({ period: MetricTimeframe.Year, now: NOW });
    expect(result).toEqual({ ids: null, source: 'unavailable', reason: 'clickhouse-error' });
  });

  it('DISTINGUISHES disabled from error — the two degrade the same way but are different facts', async () => {
    clickhouseBox.client = undefined;
    const disabled = await getWindowedCollectionRanking({ period: MetricTimeframe.Day, now: NOW });
    clickhouseBox.client = { $query: mockQuery };
    mockQuery.mockRejectedValue(new Error('boom'));
    const errored = await getWindowedCollectionRanking({ period: MetricTimeframe.Day, now: NOW });
    expect(disabled).not.toEqual(errored);
    expect(errored).toEqual({ ids: null, source: 'unavailable', reason: 'clickhouse-error' });
  });

  /**
   * THE RETRY, at the level the transport actually fails.
   *
   * `@clickhouse/client` 0.2.10 throws `Socket hang up after 3 retries` the moment every
   * pooled keep-alive socket it tries is past `keep_alive.socket_ttl` — ~341 times an
   * hour against the production deployment on 2026-09-11, and once on the single live
   * `period=Month` request in that day's ingress access log. Nothing is sent, so
   * the failure is instantaneous; a second ask opens a fresh connection.
   */
  describe('the retry', () => {
    it('re-asks once after a Socket-hang-up and serves the ranking', async () => {
      mockQuery
        .mockRejectedValueOnce(new Error('ClickHouse query failed: Socket hang up after 3 retries'))
        .mockResolvedValueOnce([{ id: 5 }, { id: 8 }]);
      const result = await getWindowedCollectionRanking({
        period: MetricTimeframe.Month,
        now: NOW,
      });
      expect(result).toEqual({ ids: [5, 8], source: 'clickhouse' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('costs nothing on the happy path — one success is one ask', async () => {
      mockQuery.mockResolvedValueOnce([{ id: 1 }]);
      await getWindowedCollectionRanking({ period: MetricTimeframe.Month, now: NOW });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('is BOUNDED at CH_RANKING_MAX_ATTEMPTS — it is a retry, not a spin', async () => {
      mockQuery.mockRejectedValue(
        new Error('ClickHouse query failed: Socket hang up after 3 retries')
      );
      await getWindowedCollectionRanking({ period: MetricTimeframe.Month, now: NOW });
      expect(mockQuery).toHaveBeenCalledTimes(CH_RANKING_MAX_ATTEMPTS);
    });

    /**
     * 🔴 THE BUDGET IS THE HALF THAT MATTERS, because it is what stops the retry
     * doubling the failure mode it is NOT for: a 30 s `request_timeout` against a
     * saturated server. The clock, not an attempt counter, separates the two — so
     * this test makes the first attempt SLOW and asserts there is no second one.
     */
    it('does not retry a failure that already spent the whole budget', async () => {
      mockQuery.mockImplementation(async () => {
        vi.advanceTimersByTime(CH_RANKING_RETRY_BUDGET_MS + 1);
        throw new Error('ClickHouse query failed: Timeout error');
      });
      const result = await getWindowedCollectionRanking({
        period: MetricTimeframe.Month,
        now: NOW,
      });
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ids: null, source: 'unavailable', reason: 'clickhouse-error' });
    });

    it('still retries a failure that spent only PART of the budget', async () => {
      // The boundary from the other side: same shape, one millisecond under. Without
      // this, a mutant that never retries would survive the test above.
      mockQuery
        .mockImplementationOnce(async () => {
          vi.advanceTimersByTime(CH_RANKING_RETRY_BUDGET_MS - 1);
          throw new Error('ClickHouse query failed: Socket hang up after 3 retries');
        })
        .mockResolvedValueOnce([{ id: 42 }]);
      const result = await getWindowedCollectionRanking({
        period: MetricTimeframe.Month,
        now: NOW,
      });
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ ids: [42], source: 'clickhouse' });
    });
  });

  it('an empty window is an EMPTY LIST, not an unavailability — the caller decides', async () => {
    mockQuery.mockResolvedValueOnce([]);
    const result = await getWindowedCollectionRanking({ period: MetricTimeframe.Day, now: NOW });
    expect(result).toEqual({ ids: [], source: 'clickhouse' });
  });

  it('carries no caller-supplied text into the SQL — depth is truncated to an integer', async () => {
    // `$query` interpolates rather than binds. Nothing here takes a caller string,
    // and the one numeric knob is floored, so a fractional value cannot smuggle
    // characters into the statement.
    await getWindowedCollectionRanking({ period: MetricTimeframe.Day, now: NOW, depth: 12.9 });
    expect(mockQuery.mock.calls[0][0] as string).toContain('LIMIT 12');
  });
});
