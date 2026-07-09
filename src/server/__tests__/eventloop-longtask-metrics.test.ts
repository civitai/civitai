import { describe, it, expect, beforeAll, vi } from 'vitest';
import client from 'prom-client';

// ---------------------------------------------------------------------------
// WHY THIS TEST EXISTS
//
// The eventloop-longtask metrics shipped broken (civitai PR #2451): the Axiom log
// line fired on every detected block, but the Prometheus counter stayed 0, the
// histogram never exported, and the lag gauge never appeared. Root cause: the
// metrics were registered in a DIFFERENT prom-client registry (the instrumentation
// webpack graph's `client.register`) than the one /metrics scrapes (the request
// graph's), so `.inc()`/`.observe()`/`collect()` updated objects nobody scraped.
//
// The fix registers all three metrics into a single globalThis-pinned
// `instrumentationRegistry` and merges it into /metrics. This test proves the
// emission path (recordDrift) actually mutates the REGISTERED metric — asserted by
// reading the registry, NOT a throwaway mock — and that the gauge is registered and
// collectable. The original test mocked prom/client with disposable `{inc: vi.fn()}`
// objects, which is exactly why the bug got through.
// ---------------------------------------------------------------------------

// A real registry that stands in for the cross-graph shared `instrumentationRegistry`.
// Using a real prom-client Registry (not a mock) is the whole point: it's the object
// the assertions read, and the same object the module-under-test registers into.
// vi.hoisted so it's initialized before the hoisted vi.mock factory references it.
const { testRegistry } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const promClient = require('prom-client');
  return { testRegistry: new promClient.Registry() as client.Registry };
});

// Override the global setup.ts mock of ~/server/prom/client with REAL registry
// semantics, but WITHOUT importing the real module (which pulls in DB pools). The
// shape mirrors the real exports the module-under-test uses.
vi.mock('~/server/prom/client', () => {
  function registerInstrumentationMetric<M extends client.Metric<string>>(
    name: string,
    factory: () => M
  ): M {
    const existing = testRegistry.getSingleMetric(name);
    if (existing) return existing as unknown as M;
    return factory();
  }
  return {
    instrumentationRegistry: testRegistry,
    registerInstrumentationMetric,
    // Legacy helpers the module no longer uses, kept for any incidental import.
    registerCounter: () => ({ inc: vi.fn() }),
    registerHistogram: () => ({ observe: vi.fn() }),
  };
});

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

import {
  recordDrift,
  classifyDrift,
  __initEventLoopDelayGaugesForTests,
  type DriftClassification,
} from '~/server/eventloop-longtask';

const PREFIX = 'civitai_app_';
const COUNTER = PREFIX + 'eventloop_longtask_total';
const SUSPENSION = PREFIX + 'eventloop_longtask_suspension_total';
const HISTOGRAM = PREFIX + 'eventloop_longtask_duration_seconds';
const GAUGE = PREFIX + 'eventloop_delay_ms';

const block = (blockedMs: number): DriftClassification => ({ kind: 'block', blockedMs });
const suspension = (gapMs: number): DriftClassification => ({ kind: 'suspension', gapMs });

// Read the current value of a single child series from the shared registry. Reading
// from the REGISTRY (not the metric object directly) is what proves the metric the
// detector mutates is the one that gets scraped.
async function counterValue(name: string): Promise<number> {
  const metric = testRegistry.getSingleMetric(name) as client.Counter<string> | undefined;
  if (!metric) return NaN;
  const { values } = await metric.get();
  return values.reduce((sum, v) => sum + v.value, 0);
}

async function histogramCount(name: string, label: string): Promise<number> {
  const metric = testRegistry.getSingleMetric(name) as client.Histogram<string> | undefined;
  if (!metric) return NaN;
  const { values } = await metric.get();
  // The _count series carries metricName + '_count' and the matching label set.
  const countSeries = values.find(
    (v) => v.metricName === `${name}_count` && v.labels.label === label
  );
  return countSeries?.value ?? 0;
}

describe('eventloop-longtask metrics: emission reaches the REGISTERED metric', () => {
  const recordOpts = { logMinMs: 50, threshold: 50, logPerMin: 30 };

  it('registers all three metrics in the shared instrumentation registry on import', () => {
    // Importing the module evaluates the module-level metric construction.
    expect(testRegistry.getSingleMetric(COUNTER)).toBeDefined();
    expect(testRegistry.getSingleMetric(SUSPENSION)).toBeDefined();
    expect(testRegistry.getSingleMetric(HISTOGRAM)).toBeDefined();
  });

  it('a detected block INCREMENTS the registered counter (the bug: it stayed 0)', async () => {
    const before = await counterValue(COUNTER);
    recordDrift(block(735), recordOpts); // 735ms — the exact prod log example
    const after = await counterValue(COUNTER);
    expect(after).toBe(before + 1);
  });

  it('a detected block OBSERVES the registered histogram (the bug: never exported)', async () => {
    const before = await histogramCount(HISTOGRAM, 'unlabeled');
    recordDrift(block(120), recordOpts);
    const after = await histogramCount(HISTOGRAM, 'unlabeled');
    expect(after).toBe(before + 1);

    // And the histogram now exports at least one series via the registry scrape.
    const scraped = await testRegistry.getSingleMetricAsString(HISTOGRAM);
    expect(scraped).toContain(HISTOGRAM);
    expect(scraped).toContain('label="unlabeled"');
  });

  it('multiple blocks accumulate on the registered counter', async () => {
    const before = await counterValue(COUNTER);
    recordDrift(block(60), recordOpts);
    recordDrift(block(900), recordOpts);
    recordDrift(block(51), recordOpts);
    expect(await counterValue(COUNTER)).toBe(before + 3);
  });

  it('a suspension increments the suspension counter, NOT the block counter/histogram', async () => {
    const blockBefore = await counterValue(COUNTER);
    const histBefore = await histogramCount(HISTOGRAM, 'unlabeled');
    const suspBefore = await counterValue(SUSPENSION);

    recordDrift(suspension(8000), recordOpts);

    expect(await counterValue(SUSPENSION)).toBe(suspBefore + 1);
    expect(await counterValue(COUNTER)).toBe(blockBefore); // unchanged
    expect(await histogramCount(HISTOGRAM, 'unlabeled')).toBe(histBefore); // unchanged
  });

  it('an ok (sub-threshold) result touches no metric', async () => {
    const c = await counterValue(COUNTER);
    const s = await counterValue(SUSPENSION);
    recordDrift({ kind: 'ok', blockedMs: 10 }, recordOpts);
    expect(await counterValue(COUNTER)).toBe(c);
    expect(await counterValue(SUSPENSION)).toBe(s);
  });

  it('the recordDrift path matches what classifyDrift produces end-to-end', async () => {
    // A real 320ms gap at tick=20 => block of 300ms => counter +1, histogram +1.
    const cBefore = await counterValue(COUNTER);
    const hBefore = await histogramCount(HISTOGRAM, 'unlabeled');
    const classified = classifyDrift(1320, 1000, 20, 50, 5000);
    expect(classified).toEqual({ kind: 'block', blockedMs: 300 });
    recordDrift(classified, recordOpts);
    expect(await counterValue(COUNTER)).toBe(cBefore + 1);
    expect(await histogramCount(HISTOGRAM, 'unlabeled')).toBe(hBefore + 1);
  });
});

describe('eventloop-longtask metrics: lag gauge is registered + collectable when armed', () => {
  beforeAll(() => {
    __initEventLoopDelayGaugesForTests();
  });

  it('registers civitai_app_eventloop_delay_ms in the shared registry', () => {
    expect(testRegistry.getSingleMetric(GAUGE)).toBeDefined();
  });

  it('the gauge collect() hook runs on scrape and emits quantile series', async () => {
    // metrics() triggers each metric's collect(); the gauge reads the live libuv
    // histogram and sets p50/p90/p99/max/mean. This is the path that produced ZERO
    // series before the fix.
    const scraped = await testRegistry.getSingleMetricAsString(GAUGE);
    expect(scraped).toContain(GAUGE);
    expect(scraped).toContain('quantile="p50"');
    expect(scraped).toContain('quantile="p99"');
    expect(scraped).toContain('quantile="mean"');
  });
});
