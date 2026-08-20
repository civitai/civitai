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
//
// The approximation has one limit worth knowing before adding a case: `prom-client` is
// externalized, so resetModules does NOT hand each "graph" its own default `client.register` the
// way a real webpack split does. Both share one. Never infer graph identity from that registry.
import promClient from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ~/server/prom/client is the module UNDER TEST here, so the blanket stub in src/__tests__/setup.ts
// (which exists to keep other suites from opening real DB pools at import time) has to come off.
vi.unmock('~/server/prom/client');

// ...which means this suite owns the reason that stub exists. Both pg modules build real pools at
// module scope; the gauges only ever read the three pool counters, so a counter-shaped stub is a
// faithful stand-in for what the code under test actually consumes.
//
// 🔴 EVERY ONE OF THESE TWELVE NUMBERS IS DISTINCT, AND THAT IS THE WHOLE POINT.
// The nine pg gauges are nine near-identical `this.set(pgDbX.yCount)` statements, which is a pure
// transposition hazard: reading `pgDbRead` where `pgDbWrite` was meant, or `.totalCount` where
// `.idleCount` was meant, is a one-token slip no type checker can catch, because every one of
// them is the same shape and the same type. A fixture of zeros — or of any value shared between two pools — makes all of those slips
// render byte-identical output, so the tests pass and the gauges silently report another pool's
// numbers. Measured: with an all-zero stub, five such mutants SURVIVED a fully green suite — and
// later, with the value assertions briefly removed, an all-zero fixture survived again.
// Pairwise-distinct values are what make a transposition observable at all.
// Keep them distinct if you touch this.
const pools = {
  read: { totalCount: 11, idleCount: 12, waitingCount: 13 },
  write: { totalCount: 21, idleCount: 22, waitingCount: 23 },
  readLong: { totalCount: 31, idleCount: 32, waitingCount: 33 },
  datapacket: { totalCount: 41, idleCount: 42, waitingCount: 43 },
} as Record<string, { totalCount: number; idleCount: number; waitingCount: number } | undefined>;

// Exposed as GETTERS, not as captured values. Vite compiles `import { pgDbReadLong }` into a
// namespace property access at each use site, so a getter is re-read every time the gauge's
// collect() runs — which lets a test drop a pool to `undefined` and exercise the null-guard branch
// against real code. Capturing the values here instead would bind whatever the mock factory saw on
// its first run, and the absent-pool case would silently assert against a pool that is still
// present (it did, before this was changed).
vi.mock('~/server/db/pgDb', () => ({
  get pgDbRead() {
    return pools.read;
  },
  get pgDbWrite() {
    return pools.write;
  },
  get pgDbReadLong() {
    return pools.readLong;
  },
}));
vi.mock('~/server/db/datapacketDb', () => ({
  get datapacketDbRead() {
    return pools.datapacket;
  },
}));

const POOL_DEFAULTS = {
  read: { totalCount: 11, idleCount: 12, waitingCount: 13 },
  write: { totalCount: 21, idleCount: 22, waitingCount: 23 },
  readLong: { totalCount: 31, idleCount: 32, waitingCount: 33 },
  datapacket: { totalCount: 41, idleCount: 42, waitingCount: 43 },
};
const restorePools = () => {
  for (const [k, v] of Object.entries(POOL_DEFAULTS)) pools[k] = { ...v };
};

type BulkheadGlobals = typeof globalThis & {
  __civitaiBulkheadState?: unknown;
  __civitaiInstrumentationRegistry?: { clear?: () => void };
  pgGaugeInitialized?: boolean;
};

// The pins under test live on globalThis, which vitest does NOT reset between tests — so without
// this each test would inherit the previous one's slots, rejects and registered gauges, and a test
// asserting "the second graph sees it" could pass on residue from the first. Clearing here is what
// makes each case start from the honest empty state a fresh pod has.
//
// 🔴 `pgGaugeInitialized` AND `client.register` MUST BOTH BE RESET, TOGETHER.
// They are the reason an earlier version of the pg test was VACUOUS: the flag survived from the
// first test that imported prom/client, so every later import took the early-out, the pg block
// never executed, and an assertion about where those gauges land was really an assertion about
// code that never ran. Two mutants proved it — adding `registers: [instrumentationRegistry]` to a
// pg gauge, and disabling the whole pg block with `if (false)` — both SURVIVED a green run.
//
// Resetting the flag ALONE does not work either: `prom-client` is externalized, so
// `vi.resetModules()` hands every "graph" the SAME module instance and therefore the same default
// `client.register`. Re-running the pg block against a registry that still holds the previous
// test's gauges throws "A metric with the name … has already been registered". Clearing the
// registry is what makes the flag reset survivable — which is also a live demonstration that this
// suite's two "graphs" share one default registry, so a test must never infer graph identity from
// it.
const clearCrossGraphState = () => {
  const g = globalThis as BulkheadGlobals;
  delete g.__civitaiBulkheadState;
  g.__civitaiInstrumentationRegistry?.clear?.();
  delete g.__civitaiInstrumentationRegistry;
  delete g.pgGaugeInitialized;
  promClient.register.clear();
};

beforeEach(() => {
  vi.resetModules();
  clearCrossGraphState();
  restorePools();
});

afterEach(() => {
  clearCrossGraphState();
  restorePools();
});

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

    expect(Object.fromEntries(graphB.bulkheadSnapshot().map((s) => [s.key, s.active]))).toEqual({
      'heavy-image': 2,
      'other-key': 1,
    });
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
    expect(
      instrumentationRegistry.getSingleMetric('civitai_app_heavy_bulkhead_active')
    ).toBeTruthy();
    expect(
      instrumentationRegistry.getSingleMetric('civitai_app_heavy_bulkhead_rejects')
    ).toBeTruthy();
  });

  // 🔴 The pg pool gauges deliberately do NOT reach the shared registry — moving them there makes
  // them read a non-serving pool, which is worse than their current absence. See the long note
  // above the pg block in src/server/prom/client.ts. These two cases pin BOTH halves of that:
  // where they land, and that they still read the right pool if anyone ever revives them.
  it('keeps the pg pool gauges on the per-graph default registry, not the shared one', async () => {
    const { instrumentationRegistry } = await importAsBothGraphs();

    for (const name of [
      'node_postgres_read_total_count',
      'node_postgres_write_waiting_count',
      'node_postgres_pool_idle_count',
    ]) {
      // Present on the default registry — proves the pg block RAN. Without this half the next
      // assertion is satisfied by a deleted block just as well as by a correctly-placed one.
      expect(promClient.register.getSingleMetric(name), `${name} on default`).toBeTruthy();
      // Absent from the scraped shared registry — the invariant the note exists to protect.
      expect(
        instrumentationRegistry.getSingleMetric(name),
        `${name} on instrumentation`
      ).toBeUndefined();
    }
  });

  // Existence is a weak assertion for these nine: they are nine near-identical `this.set(pool.x)`
  // statements, so a wrong pool or wrong counter still produces a registered, non-empty gauge and
  // only the VALUE distinguishes them. Every expected number is unique across the fixture, so a
  // transposition renders a value that appears nowhere in the expected set rather than
  // coincidentally matching a sibling. This is what the pairwise-distinct fixture above is FOR.
  it('maps every pg gauge to the right pool and the right counter', async () => {
    await importAsBothGraphs();
    const scraped = await promClient.register.metrics();

    for (const line of [
      'node_postgres_read_total_count 11',
      'node_postgres_read_idle_count 12',
      'node_postgres_read_waiting_count 13',
      'node_postgres_write_total_count 21',
      'node_postgres_write_idle_count 22',
      'node_postgres_write_waiting_count 23',
      'node_postgres_pool_total_count{pool="read"} 11',
      'node_postgres_pool_total_count{pool="write"} 21',
      'node_postgres_pool_total_count{pool="read_long"} 31',
      'node_postgres_pool_total_count{pool="datapacket_read"} 41',
      'node_postgres_pool_idle_count{pool="read"} 12',
      'node_postgres_pool_idle_count{pool="write"} 22',
      'node_postgres_pool_idle_count{pool="read_long"} 32',
      'node_postgres_pool_idle_count{pool="datapacket_read"} 42',
      'node_postgres_pool_waiting_count{pool="read"} 13',
      'node_postgres_pool_waiting_count{pool="write"} 23',
      'node_postgres_pool_waiting_count{pool="read_long"} 33',
      'node_postgres_pool_waiting_count{pool="datapacket_read"} 43',
    ]) {
      expect(scraped, line).toContain(line);
    }
  });

  // The labelled gauges guard each pool with `?.` + `?? 0`, which has no observable effect while
  // every pool is present — so deleting it survives any all-pools-present fixture. An absent pool
  // is the only input that reaches the branch, and the contract is that it reports 0 rather than
  // throwing `Value is not a valid number` out of Gauge.set and rejecting the whole scrape.
  it('reports 0 for an absent pool instead of throwing out of collect()', async () => {
    pools.readLong = undefined;
    await importAsBothGraphs();

    const scraped = await promClient.register.metrics();
    expect(scraped).toContain('node_postgres_pool_total_count{pool="read_long"} 0');
    expect(scraped).toContain('node_postgres_pool_waiting_count{pool="read_long"} 0');
    // The surviving pools must be untouched — a guard that swallows too much would zero them too.
    expect(scraped).toContain('node_postgres_pool_total_count{pool="write"} 21');
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
