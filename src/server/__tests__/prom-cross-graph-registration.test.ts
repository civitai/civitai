// Regression cover for the defect that made civitai_app_heavy_bulkhead_{active,rejects} emit ZERO
// series in production between 2026-06-07 and this fix, while every other link in the chain looked
// healthy (registered in code, merged to release, in the running image, on a hot route, on pods
// emitting hundreds of thousands of other series).
//
// Next.js compiles instrumentation.ts into a SEPARATE webpack bundle from the API-route/pages
// bundle, and prom-client is not in serverExternalPackages, so each bundle gets its own module
// instances — its own `client.register`, and its own copy of any module-level state. Two things
// therefore have to be shared on globalThis for a collect()-based gauge to work at all:
//
//   1. the REGISTRY it is registered into      (src/server/prom/client.ts)
//   2. the STATE its collect() closure reads   (src/server/utils/request-bulkhead.ts)
//
// The old code shared neither. It guarded registration with a globalThis FLAG
// (`heavyBulkheadGaugeInitialized`) while writing to a per-graph registry, which is worse than no
// guard: the instrumentation graph reached the module first (instrumentation.node.ts ->
// ~/server/eventloop-longtask -> ~/server/prom/client), claimed the flag, registered into its own
// unscraped registry, and the pages graph — the one /api/metrics actually scrapes — then took the
// early-out and registered nothing.
//
// `vi.resetModules()` between two dynamic imports is the closest a single-process test gets to that
// two-graph split: it forces a fresh module instance while leaving globalThis intact, which is
// exactly the asymmetry the bug lived in. Anything pinned on globalThis survives; anything
// module-local does not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ~/server/prom/client is the module UNDER TEST here, so the blanket stub in src/__tests__/setup.ts
// (which exists to keep other suites from opening real DB pools at import time) has to come off.
vi.unmock('~/server/prom/client');

// ...which means this suite owns the reason that stub exists. Both pg modules build real pools at
// module scope; the gauges only ever read the three pool counters, so a counter-shaped stub is a
// faithful stand-in for what the code under test actually consumes.
const poolStub = () => ({ totalCount: 0, idleCount: 0, waitingCount: 0 });
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: poolStub(),
  pgDbWrite: poolStub(),
  pgDbReadLong: poolStub(),
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: poolStub() }));

type BulkheadGlobals = typeof globalThis & {
  __civitaiBulkheadSlots?: unknown;
  __civitaiBulkheadRejects?: unknown;
  __civitaiInstrumentationRegistry?: { clear?: () => void };
};

// The pins under test live on globalThis, which vitest does NOT reset between tests — so without
// this each test would inherit the previous one's slots, rejects and registered gauges, and a test
// asserting "the second graph sees it" could pass on residue from the first. Clearing here is what
// makes each case start from the honest empty state a fresh pod has.
const clearCrossGraphState = () => {
  const g = globalThis as BulkheadGlobals;
  delete g.__civitaiBulkheadSlots;
  delete g.__civitaiBulkheadRejects;
  g.__civitaiInstrumentationRegistry?.clear?.();
  delete g.__civitaiInstrumentationRegistry;
};

beforeEach(() => {
  vi.resetModules();
  clearCrossGraphState();
});

afterEach(clearCrossGraphState);

describe('request-bulkhead state is process-wide, not graph-wide', () => {
  it('a slot acquired in one graph is visible in another graph', async () => {
    const graphA = await import('~/server/utils/request-bulkhead');
    const release = graphA.acquireBulkheadSlot('heavy-image', 20);

    vi.resetModules();
    const graphB = await import('~/server/utils/request-bulkhead');

    // Before the fix this was `[]` — a fresh Map in a fresh module instance — which is precisely
    // what a collect() in the wrong graph iterated over, producing no series rather than a zero.
    expect(graphB.bulkheadSnapshot()).toEqual([{ key: 'heavy-image', active: 1, rejects: 0 }]);

    release();
    expect(graphB.bulkheadSnapshot()).toEqual([{ key: 'heavy-image', active: 0, rejects: 0 }]);
  });

  it('rejects counted in one graph are visible in another and never decrease', async () => {
    const graphA = await import('~/server/utils/request-bulkhead');
    const held = graphA.acquireBulkheadSlot('heavy-image', 1);
    expect(() => graphA.acquireBulkheadSlot('heavy-image', 1)).toThrow(/at capacity/);

    vi.resetModules();
    const graphB = await import('~/server/utils/request-bulkhead');
    expect(graphB.bulkheadSnapshot()[0].rejects).toBe(1);

    // Monotonicity is what makes rate() meaningful on the _rejects gauge: freeing a slot must not
    // walk the cumulative count back down, or every release would read as a negative rate sample.
    held();
    expect(graphB.bulkheadSnapshot()[0].rejects).toBe(1);

    expect(() => graphB.acquireBulkheadSlot('heavy-image', 0)).toThrow(/at capacity/);
    expect(graphB.bulkheadSnapshot()[0].rejects).toBe(2);
  });

  it('keeps distinct keys separate while sharing them across graphs', async () => {
    // A single shared Map keyed by name is only correct if it still partitions by key. Two keys
    // with DIFFERENT active counts would both pass a same-count assertion, so they are set apart.
    const graphA = await import('~/server/utils/request-bulkhead');
    graphA.acquireBulkheadSlot('heavy-image', 20);
    graphA.acquireBulkheadSlot('heavy-image', 20);
    graphA.acquireBulkheadSlot('other-key', 20);

    vi.resetModules();
    const graphB = await import('~/server/utils/request-bulkhead');

    expect(
      Object.fromEntries(graphB.bulkheadSnapshot().map((s) => [s.key, s.active]))
    ).toEqual({ 'heavy-image': 2, 'other-key': 1 });
  });
});

describe('prom/client registers into the registry /api/metrics scrapes', () => {
  // Simulates the real startup order: instrumentation graph first, pages graph second.
  const importAsBothGraphs = async () => {
    await import('~/server/prom/client'); // instrumentation graph, at pod start
    vi.resetModules();
    return import('~/server/prom/client'); // pages/API graph — the one that gets scraped
  };

  it('exposes the bulkhead gauges to the second graph, not just the first', async () => {
    const { instrumentationRegistry } = await importAsBothGraphs();

    // Before the fix both gauges went to the per-graph default `client.register` behind a
    // globalThis flag, so this lookup returned undefined no matter how many graphs ran.
    expect(instrumentationRegistry.getSingleMetric('civitai_app_heavy_bulkhead_active')).toBeTruthy();
    expect(
      instrumentationRegistry.getSingleMetric('civitai_app_heavy_bulkhead_rejects')
    ).toBeTruthy();
  });

  it('exposes the pg pool gauges too — same guard, same defect', async () => {
    const { instrumentationRegistry } = await importAsBothGraphs();

    for (const name of [
      'node_postgres_read_total_count',
      'node_postgres_write_waiting_count',
      'node_postgres_pool_idle_count',
    ]) {
      expect(instrumentationRegistry.getSingleMetric(name), name).toBeTruthy();
    }
  });

  it('does not register a gauge twice when both graphs evaluate the module', async () => {
    // The flag was doing one legitimate job — suppressing a duplicate registration on the second
    // evaluation. registerInstrumentationMetric has to keep doing it, or the second graph throws
    // "already registered" while the module is evaluating and takes the whole route down with it.
    await expect(importAsBothGraphs()).resolves.toBeDefined();

    const { instrumentationRegistry } = await importAsBothGraphs();
    const active = await instrumentationRegistry.getMetricsAsJSON();
    const names = active.map((m) => m.name);
    expect(names.filter((n) => n === 'civitai_app_heavy_bulkhead_active')).toHaveLength(1);
  });

  // THE SEAM. Each half above can pass while the pair is still broken: the gauge can be registered
  // in the scraped registry (test group 2) AND the state can be shared (test group 1), and the
  // metric would still emit nothing if the collect() closure that wins registration reads a
  // different module instance than the request path mutates. Only scraping the registry after
  // driving a real acquisition through the OTHER graph exercises that pairing.
  it('renders a slot taken in the request graph, though the gauge was registered by the first graph', async () => {
    const { instrumentationRegistry } = await importAsBothGraphs();
    const bulkhead = await import('~/server/utils/request-bulkhead');

    const release = bulkhead.acquireBulkheadSlot('heavy-image', 20);
    try {
      const scraped = await instrumentationRegistry.metrics();
      expect(scraped).toContain('civitai_app_heavy_bulkhead_active{key="heavy-image"} 1');
      expect(scraped).toContain('civitai_app_heavy_bulkhead_rejects{key="heavy-image"} 0');
    } finally {
      release();
    }
  });

  it('renders rejects in the scrape as a value that rate() can read', async () => {
    const { instrumentationRegistry } = await importAsBothGraphs();
    const bulkhead = await import('~/server/utils/request-bulkhead');

    const held = bulkhead.acquireBulkheadSlot('heavy-image', 1);
    expect(() => bulkhead.acquireBulkheadSlot('heavy-image', 1)).toThrow(/at capacity/);
    held();

    // Value pinned literally rather than "> 0": a mutant that reports `active` in the rejects
    // gauge would satisfy any non-zero check here, since active is also non-zero mid-flight.
    expect(await instrumentationRegistry.metrics()).toContain(
      'civitai_app_heavy_bulkhead_rejects{key="heavy-image"} 1'
    );
  });
});
