import { describe, expect, it, vi } from 'vitest';

/**
 * Its own file because `vi.mock` is per-module: every other test of this service supplies
 * a present ClickHouse client, so the two `!clickhouse` branches were reachable by no
 * test at all. Mutating the strict one to `return []` is the whole defect — metric jobs
 * writing permanently unfiltered totals wherever ClickHouse is unconfigured — and it was
 * green against the source guard, which only checks the export exists.
 */

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(() => {
    throw new Error('fetchThroughCache must not be reached without a clickhouse client');
  }),
}));
import '~/__tests__/mocks/logging.mock';

const { getMetricExcludedUserIds, getMetricExcludedUserIdsOrThrow } = await import(
  '~/server/services/metric-excluded-users.service'
);

describe('with no clickhouse client', () => {
  it('the strict reader rejects rather than reporting an empty exclusion list', async () => {
    await expect(getMetricExcludedUserIdsOrThrow()).rejects.toThrow(
      'clickhouse client unavailable'
    );
  });

  it('the lenient reader still degrades to []', async () => {
    // Asserted beside the strict one because the property is the difference between them.
    await expect(getMetricExcludedUserIds()).resolves.toEqual([]);
  });
});
