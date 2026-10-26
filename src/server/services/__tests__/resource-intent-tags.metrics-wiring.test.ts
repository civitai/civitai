import { instrumentationRegistry } from '@civitai/telemetry/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const FLAG = 'resource-intent-tag-index-build';
// Generous: the background read does cold dynamic imports, which a loaded runner makes slow.
const WAIT = { timeout: 20_000, interval: 20 };

// The gauges' cache clock (cachedRead defaults to Date.now): pushed past its 60 s TTL to probe
// whether a read has finished. Real time plus a skew that only grows.
const realNow = Date.now.bind(Date);
let skewMs = 0;

/**
 * Resolves once the background read this gauge's scrape started has fully finished: the flag read
 * and, when the flag is on, the imports and the database read. No fixed sleep, so a slow import
 * cannot outrun it, and the flag-off assertions below run after the point where a read would land.
 *
 * cachedRead starts another read only after the one in flight settled (its `finally` stamps the
 * read time; until then a scrape gets the same in-flight read back). So once that scrape's flag
 * read was asked, scraping again past the TTL asks the flag again exactly when the first read is
 * done. That probe's flag answer never arrives, so the probe itself reads nothing.
 */
async function settled(metric: { get: () => Promise<unknown> }, flagReadsBefore: number) {
  await vi.waitFor(() => expect(isFlipt).toHaveBeenCalledTimes(flagReadsBefore + 1), WAIT);
  isFlipt.mockReturnValueOnce(new Promise(() => undefined));
  await vi.waitFor(async () => {
    skewMs += 61_000;
    await metric.get();
    expect(isFlipt).toHaveBeenCalledTimes(flagReadsBefore + 2);
  }, WAIT);
}

/** One scrape of the two database-reading gauges, waiting until each one's background read ended. */
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
    const flagReadsBefore = isFlipt.mock.calls.length;
    await metric!.get();
    await settled(metric!, flagReadsBefore);
  }
}

describe('tag-index metrics wiring', () => {
  let dateNow: { mockRestore: () => void };
  afterEach(() => dateNow.mockRestore());
  beforeEach(() => {
    // Before the scrape imports the module: the gauges capture Date.now when they are created.
    skewMs = 0;
    dateNow = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);
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
    // Each gauge did run its read, and asked the build flag: once for its read, once for the probe
    // that saw that read finish.
    expect(isFlipt.mock.calls).toEqual([[FLAG], [FLAG], [FLAG], [FLAG]]);
  });

  it('with it on, the same wiring reads both (positive control)', async () => {
    isFlipt.mockResolvedValue(true);
    await scrape();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
