import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
// The lenient reader logs the outage it swallows; the canonical mock keeps that off the
// wire and gives a stable spy to assert the strict reader's own report on.
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The two readers of the exclusion list must fail in opposite directions.
 *
 * The lenient one degrades to `[]`, so the reaction milestone keeps firing on an
 * unfiltered count during an outage rather than going silent. The strict one rejects,
 * because a metric job that wrote an unfiltered total would bake it in permanently:
 * `PostMetric`/`ArticleMetric`/`BountyEntryMetric` are only recomputed for entities
 * that receive another reaction, so a quiet entity never gets a second chance.
 */

const h = vi.hoisted(() => ({
  fetchThroughCache: vi.fn(),
  chQuery: vi.fn(),
}));

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: h.fetchThroughCache,
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: h.chQuery },
}));

const { getMetricExcludedUserIds, getMetricExcludedUserIdsOrThrow } = await import(
  '~/server/services/metric-excluded-users.service'
);

/** Runs the real fetch function, so the row mapping and filtering are exercised. */
const cachePassthrough = () =>
  h.fetchThroughCache.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn());

beforeEach(() => {
  vi.clearAllMocks();
  h.fetchThroughCache.mockReset();
  h.chQuery.mockReset();
});

describe('getMetricExcludedUserIdsOrThrow', () => {
  it('returns the same ids as the lenient reader when the read succeeds', async () => {
    cachePassthrough();
    h.chQuery.mockResolvedValue([{ userId: 11 }, { userId: 22 }]);

    await expect(getMetricExcludedUserIdsOrThrow()).resolves.toEqual([11, 22]);
    await expect(getMetricExcludedUserIds()).resolves.toEqual([11, 22]);
  });

  it('rejects when the read fails, where the lenient reader returns []', async () => {
    h.fetchThroughCache.mockRejectedValue(new Error('clickhouse unreachable'));

    // Asserted as a pair, in one test, because the property is the DIFFERENCE. Split
    // across two tests, deleting the strict reader and re-pointing its callers at the
    // lenient one leaves a green suite.
    await expect(getMetricExcludedUserIdsOrThrow()).rejects.toThrow('clickhouse unreachable');
    await expect(getMetricExcludedUserIds()).resolves.toEqual([]);
  });

  it('rejects when the cache hands back something that is not an array', async () => {
    // `fetchThroughCache` returns any present `data` unvalidated, so this is a real
    // shape rather than a defensive one.
    h.fetchThroughCache.mockResolvedValue(null);

    await expect(getMetricExcludedUserIdsOrThrow()).rejects.toThrow('not an array');
    await expect(getMetricExcludedUserIds()).resolves.toEqual([]);
  });

  it('still reports the stalled metric run after the lenient reader already reported', async () => {
    // The report is deduped per outage so the reaction write path cannot amplify logs.
    // Deduped on ONE flag it was unreachable: the lenient reader runs on every reaction
    // toggle, so it fails first, claims the slot, and the only line for the whole incident
    // says a notification degraded — while the metric jobs stall silently once a minute.
    // The dedupe set is module scope and survives `clearAllMocks`, so an earlier failing
    // test would otherwise leave it populated and these assertions would read a report
    // that never happened. One successful read clears it.
    cachePassthrough();
    h.chQuery.mockResolvedValue([]);
    await getMetricExcludedUserIds();
    loggingMock.logToAxiom.mockClear();

    h.fetchThroughCache.mockRejectedValue(new Error('clickhouse unreachable'));

    await expect(getMetricExcludedUserIds()).resolves.toEqual([]);
    await expect(getMetricExcludedUserIdsOrThrow()).rejects.toThrow();

    const messages = loggingMock.logToAxiom.mock.calls.map(
      ([arg]: [{ message: string }]) => arg.message
    );
    expect(messages).toContain('Exclusion list unavailable, falling back to an unfiltered count');
    expect(messages).toContain('Exclusion list unavailable, skipping the metric run');
  });

  it('does not repeat the same outcome while the outage continues', async () => {
    // The other half of the property: keyed per outcome, not per call.
    // The dedupe set is module scope and survives `clearAllMocks`, so an earlier failing
    // test would otherwise leave it populated and these assertions would read a report
    // that never happened. One successful read clears it.
    cachePassthrough();
    h.chQuery.mockResolvedValue([]);
    await getMetricExcludedUserIds();
    loggingMock.logToAxiom.mockClear();

    h.fetchThroughCache.mockRejectedValue(new Error('clickhouse unreachable'));

    await expect(getMetricExcludedUserIds()).resolves.toEqual([]);
    await expect(getMetricExcludedUserIds()).resolves.toEqual([]);

    const lenient = loggingMock.logToAxiom.mock.calls.filter(
      ([arg]: [{ message: string }]) =>
        arg.message === 'Exclusion list unavailable, falling back to an unfiltered count'
    );
    expect(lenient).toHaveLength(1);
  });

  it('drops a null userId rather than suppressing user 0', async () => {
    cachePassthrough();
    h.chQuery.mockResolvedValue([{ userId: null }, { userId: 7 }]);

    await expect(getMetricExcludedUserIdsOrThrow()).resolves.toEqual([7]);
  });
});
