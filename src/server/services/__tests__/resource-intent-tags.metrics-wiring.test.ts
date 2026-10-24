import { instrumentationRegistry } from '@civitai/telemetry/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The tag-index metrics as the app registers them (module scope, the real cross-graph registry):
 * with the build flag off, a scrape reads nothing from the database for the job's heartbeats or the
 * newest ready snapshot. The flag-on case is the positive control that the same wiring does read.
 */

const isFlipt = vi.hoisted(() => vi.fn());
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { RESOURCE_INTENT_TAG_INDEX_BUILD: 'resource-intent-tag-index-build' },
  isFlipt,
}));

type Spy = ReturnType<typeof vi.fn>;
const findMany = dbMock.dbRead.keyValue.findMany as unknown as Spy;
const queryRaw = dbMock.dbRead.$queryRaw as unknown as Spy;

/** One scrape of the two database-reading gauges, then let their background reads settle. */
async function scrape() {
  // A fresh registration, as a pod's first import of the module makes it.
  instrumentationRegistry.clear();
  vi.resetModules();
  const { TAG_INDEX_METRICS } = await import('~/server/prom/resource-intent-tags.metrics');
  const names = [TAG_INDEX_METRICS.newestReadyCreated, TAG_INDEX_METRICS.buildLastSuccess];
  // One gauge at a time: vitest can hand the second of two concurrent first imports of a mocked
  // module the unmocked one (measured here), which is a property of the test runner, not the code.
  for (const name of names) {
    const metric = instrumentationRegistry.getSingleMetric(name);
    expect(metric, name).toBeDefined();
    await metric!.get();
    // Let its background read settle (a flag read, then maybe a database read: both mocked).
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 50));
}

describe('tag-index metrics wiring', () => {
  beforeEach(() => {
    isFlipt.mockReset();
    findMany.mockReset();
    queryRaw.mockReset();
    findMany.mockResolvedValue([]);
    queryRaw.mockResolvedValue([]);
  });

  it('with the build flag off, a scrape reads the flag and nothing from the database', async () => {
    isFlipt.mockResolvedValue(false);
    await scrape();
    expect(findMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
    // Each gauge did run its read, and asked the build flag.
    expect(isFlipt.mock.calls).toEqual([
      ['resource-intent-tag-index-build'],
      ['resource-intent-tag-index-build'],
    ]);
  });

  it('with it on, the same wiring reads both (positive control)', async () => {
    isFlipt.mockResolvedValue(true);
    await scrape();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
