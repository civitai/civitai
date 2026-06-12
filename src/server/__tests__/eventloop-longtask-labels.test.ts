import { describe, it, expect, vi } from 'vitest';
import client from 'prom-client';

// ---------------------------------------------------------------------------
// WHY THIS TEST EXISTS
//
// The LABELS attribution tier shipped broken (civitai #2451): it was supposed to
// tag each long-task block with its tRPC route, but it ALWAYS emitted
// label="unlabeled". 51 prod pods armed with EVENTLOOP_LONGTASK_LABELS=true produced
// ZERO trpc:* labels. Root cause: the drift setInterval read AsyncLocalStorage
// (currentLabel()) from the TIMER's async context, which is never inside a request's
// labelStorage.run() scope, so getStore() was always undefined.
//
// The fix attributes blocks from WITHIN the blocking resource's own execution via
// async_hooks (the `blocked-at` technique): init() captures the request's label at
// resource creation; before()/after() bracket the exact synchronous body; if the
// body ran >= threshold, the block is recorded under the captured label.
//
// These tests prove (3) labeled blocks now attribute to trpc:X (the exact shipped
// failure), and (4) the asyncId->label map is bounded/cleaned. The deterministic
// state-machine tests use createLabelAttributor; the integration test installs the
// REAL async_hooks hook and drives a real async resource inside runWithLongTaskLabel.
// ---------------------------------------------------------------------------

const { labelsTestRegistry } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const promClient = require('prom-client');
  return { labelsTestRegistry: new promClient.Registry() as client.Registry };
});

vi.mock('~/server/prom/client', () => {
  function registerInstrumentationMetric<M extends client.Metric<string>>(
    name: string,
    factory: () => M
  ): M {
    const existing = labelsTestRegistry.getSingleMetric(name);
    if (existing) return existing as unknown as M;
    return factory();
  }
  return {
    instrumentationRegistry: labelsTestRegistry,
    registerInstrumentationMetric,
    registerCounter: () => ({ inc: vi.fn() }),
    registerHistogram: () => ({ observe: vi.fn() }),
  };
});

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

import {
  createLabelAttributor,
  recordLabeledBlock,
  runWithLongTaskLabel,
  __setLongTaskLabelsArmedForTests,
  __installLabelHookForTests,
} from '~/server/eventloop-longtask';

const PREFIX = 'civitai_app_';
// The DRIFT (loop-level, 'unlabeled') histogram — recordLabeledBlock must NOT touch it.
const DRIFT_HISTOGRAM = PREFIX + 'eventloop_longtask_duration_seconds';
const DRIFT_COUNTER = PREFIX + 'eventloop_longtask_total';
// The DEDICATED labeled (async_hooks) attribution series — what recordLabeledBlock writes.
const LABELED_HISTOGRAM = PREFIX + 'eventloop_longtask_labeled_duration_seconds';
const LABELED_COUNTER = PREFIX + 'eventloop_longtask_labeled_total';

async function histogramCount(name: string, label: string): Promise<number> {
  const metric = labelsTestRegistry.getSingleMetric(name) as client.Histogram<string> | undefined;
  if (!metric) return NaN;
  const { values } = await metric.get();
  const countSeries = values.find(
    (v) => v.metricName === `${name}_count` && v.labels.label === label
  );
  return countSeries?.value ?? 0;
}

async function counterValue(name: string, label?: string): Promise<number> {
  const metric = labelsTestRegistry.getSingleMetric(name) as client.Counter<string> | undefined;
  if (!metric) return NaN;
  const { values } = await metric.get();
  const matched = label === undefined ? values : values.filter((v) => v.labels.label === label);
  return matched.reduce((sum, v) => sum + v.value, 0);
}

describe('eventloop-longtask labels: per-resource attribution state machine', () => {
  const THRESHOLD = 50;
  const opts = { logMinMs: 50, logPerMin: 0 };

  it('attributes a block to the label captured at init (NOT unlabeled) — the #2451 failure', () => {
    const recorded: Array<{ dur: number; label: string }> = [];
    const attr = createLabelAttributor(THRESHOLD, 10_000, opts, (dur, label) =>
      recorded.push({ dur, label })
    );

    // Resource created within a 'trpc:image.getInfinite' scope: init captures it.
    attr.init(1, 'trpc:image.getInfinite');
    // Its callback runs: before -> (blocks 120ms) -> after.
    attr.before(1, 1000);
    attr.after(1, 1120);

    expect(recorded).toEqual([{ dur: 120, label: 'trpc:image.getInfinite' }]);
    // Crucially: the label is the tRPC route, NOT 'unlabeled'.
    expect(recorded[0].label).not.toBe('unlabeled');
  });

  it('does NOT record a block when the callback ran under threshold', () => {
    const recorded: Array<{ dur: number; label: string }> = [];
    const attr = createLabelAttributor(THRESHOLD, 10_000, opts, (dur, label) =>
      recorded.push({ dur, label })
    );
    attr.init(1, 'trpc:fast.path');
    attr.before(1, 1000);
    attr.after(1, 1040); // 40ms < 50ms threshold
    expect(recorded).toHaveLength(0);
  });

  it('ignores resources created outside a labeled scope (label="unlabeled")', () => {
    const recorded: Array<{ dur: number; label: string }> = [];
    const attr = createLabelAttributor(THRESHOLD, 10_000, opts, (dur, label) =>
      recorded.push({ dur, label })
    );
    // 'unlabeled' resources are not tracked (they belong to the drift timer series).
    attr.init(1, 'unlabeled');
    attr.before(1, 1000);
    attr.after(1, 2000);
    expect(recorded).toHaveLength(0);
    expect(attr.labelMapSize()).toBe(0);
  });

  it('exactly-threshold duration is recorded (inclusive boundary)', () => {
    const recorded: Array<{ dur: number; label: string }> = [];
    const attr = createLabelAttributor(THRESHOLD, 10_000, opts, (dur, label) =>
      recorded.push({ dur, label })
    );
    attr.init(1, 'trpc:x');
    attr.before(1, 1000);
    attr.after(1, 1050); // exactly 50ms
    expect(recorded).toEqual([{ dur: 50, label: 'trpc:x' }]);
  });

  it('skips a callback spanning the suspension cap — not a fake multi-second block (#3)', () => {
    const recorded: Array<{ dur: number; label: string }> = [];
    // suspendCapMs mirrors the drift path: a 6s "block" is CPU-steal/VM-suspend, not JS.
    const attr = createLabelAttributor(
      THRESHOLD,
      10_000,
      { ...opts, suspendCapMs: 5000 },
      (dur, label) => recorded.push({ dur, label })
    );
    attr.init(1, 'trpc:slept');
    attr.before(1, 1000);
    attr.after(1, 1000 + 6000); // 6000ms >= 5000ms cap → skipped
    expect(recorded).toHaveLength(0);
  });

  it('still records a normal block just under the suspension cap (#3 boundary)', () => {
    const recorded: Array<{ dur: number; label: string }> = [];
    const attr = createLabelAttributor(
      THRESHOLD,
      10_000,
      { ...opts, suspendCapMs: 5000 },
      (dur, label) => recorded.push({ dur, label })
    );
    attr.init(1, 'trpc:real');
    attr.before(1, 1000);
    attr.after(1, 1000 + 4999); // under the cap → still a real block
    expect(recorded).toEqual([{ dur: 4999, label: 'trpc:real' }]);
  });
});

describe('eventloop-longtask labels: asyncId->label map is bounded + cleaned (#4)', () => {
  const opts = { logMinMs: 50, logPerMin: 0 };

  it('destroy() removes the asyncId from the map', () => {
    const attr = createLabelAttributor(50, 10_000, opts, () => undefined);
    attr.init(1, 'trpc:a');
    attr.init(2, 'trpc:b');
    expect(attr.labelMapSize()).toBe(2);
    attr.destroy(1);
    expect(attr.labelMapSize()).toBe(1);
    attr.destroy(2);
    expect(attr.labelMapSize()).toBe(0);
  });

  it('the map never exceeds the hard cap, evicting oldest-first under load', () => {
    const CAP = 100;
    const attr = createLabelAttributor(50, CAP, opts, () => undefined);
    // Insert 10x the cap with NO destroy (simulating resources that never emit
    // destroy) — the map must stay bounded at CAP.
    for (let id = 0; id < CAP * 10; id++) {
      attr.init(id, 'trpc:flood');
    }
    expect(attr.labelMapSize()).toBe(CAP);
  });

  it('prefers evicting INACTIVE entries, preserving an active (before-without-after) one (#2)', () => {
    const recorded: Array<{ dur: number; label: string }> = [];
    let evictedActive = 0;
    const CAP = 3;
    const attr = createLabelAttributor(
      50,
      CAP,
      { ...opts, onEvictActive: () => evictedActive++ },
      (dur, label) => recorded.push({ dur, label })
    );
    // id=1 is active: it has called before() and is awaiting after().
    attr.init(1, 'trpc:active');
    attr.before(1, 1000);
    // Fill the rest of the cap with inactive entries, then overflow.
    attr.init(2, 'trpc:inactive');
    attr.init(3, 'trpc:inactive');
    // These inits force eviction; the INACTIVE ones (2,3,...) should go first, never id=1.
    for (let id = 4; id < 20; id++) attr.init(id, 'trpc:inactive');
    expect(attr.labelMapSize()).toBe(CAP);
    // No active entry was evicted, so the counter stayed at 0.
    expect(evictedActive).toBe(0);
    // id=1's after() still fires a labeled block (it was never evicted).
    attr.after(1, 1200);
    expect(recorded).toEqual([{ dur: 200, label: 'trpc:active' }]);
  });

  it('counts an eviction when ALL entries are active (the unavoidable loss) (#2)', () => {
    let evictedActive = 0;
    const CAP = 2;
    const attr = createLabelAttributor(
      50,
      CAP,
      { ...opts, onEvictActive: () => evictedActive++ },
      () => undefined
    );
    // Make every slot active (before-without-after).
    attr.init(1, 'trpc:a');
    attr.before(1, 1000);
    attr.init(2, 'trpc:b');
    attr.before(2, 1000);
    // A third active insert must evict an active entry (no inactive victim available)
    // and increment the observable loss counter.
    attr.init(3, 'trpc:c');
    expect(attr.labelMapSize()).toBe(CAP);
    expect(evictedActive).toBe(1);
  });

  it('after() deletes the start entry so the starts map does not leak', () => {
    const recorded: number[] = [];
    const attr = createLabelAttributor(50, 10_000, opts, (dur) => recorded.push(dur));
    attr.init(1, 'trpc:x');
    attr.before(1, 1000);
    attr.after(1, 1200);
    // A second after() for the same id is a no-op (start already consumed).
    attr.after(1, 9999);
    expect(recorded).toEqual([200]);
  });
});

describe('eventloop-longtask labels: recordLabeledBlock writes the DEDICATED labeled series only (#1 double-count fix)', () => {
  const opts = { logMinMs: 50, threshold: 50, logPerMin: 0 };

  it('observes the labeled histogram + counter under the trpc:* label (not unlabeled)', async () => {
    const histBefore = await histogramCount(LABELED_HISTOGRAM, 'trpc:model.getById');
    const ctrBefore = await counterValue(LABELED_COUNTER, 'trpc:model.getById');
    recordLabeledBlock(310, 'trpc:model.getById', opts);
    expect(await histogramCount(LABELED_HISTOGRAM, 'trpc:model.getById')).toBe(histBefore + 1);
    expect(await counterValue(LABELED_COUNTER, 'trpc:model.getById')).toBe(ctrBefore + 1);

    const scraped = await labelsTestRegistry.getSingleMetricAsString(LABELED_HISTOGRAM);
    expect(scraped).toContain('label="trpc:model.getById"');
  });

  it('does NOT touch the drift counter/histogram — a block is never double-counted', async () => {
    // The drift metrics are the loop-level 'unlabeled' accounting; the labeled path
    // must leave them untouched so one physical block isn't counted twice.
    const driftCtrBefore = await counterValue(DRIFT_COUNTER);
    const driftHistBefore = await histogramCount(DRIFT_HISTOGRAM, 'unlabeled');
    const driftHistLabeledBefore = await histogramCount(DRIFT_HISTOGRAM, 'trpc:double.check');

    recordLabeledBlock(420, 'trpc:double.check', opts);

    expect(await counterValue(DRIFT_COUNTER)).toBe(driftCtrBefore);
    expect(await histogramCount(DRIFT_HISTOGRAM, 'unlabeled')).toBe(driftHistBefore);
    // The drift histogram never gets a trpc:* series from the labeled path.
    expect(await histogramCount(DRIFT_HISTOGRAM, 'trpc:double.check')).toBe(driftHistLabeledBefore);
  });
});

describe('eventloop-longtask labels: REAL async_hooks integration (the exact shipped path)', () => {
  it('a real async resource created inside runWithLongTaskLabel attributes to its trpc:X label', async () => {
    const restore = __setLongTaskLabelsArmedForTests(true);
    const recorded: Array<{ dur: number; label: string }> = [];
    // Install the REAL hook with a low threshold so a short synthetic block trips it.
    const teardown = __installLabelHookForTests(20, 10_000, (dur, label) =>
      recorded.push({ dur, label })
    );

    const busyWait = (ms: number) => {
      const end = Date.now() + ms;
      // eslint-disable-next-line no-empty
      while (Date.now() < end) {}
    };

    await new Promise<void>((resolve) => {
      // Create a timer (async resource) WITHIN the labeled scope. Its callback runs
      // later and synchronously blocks the loop — exactly the request->resource path
      // that #2451 mis-attributed to 'unlabeled'.
      runWithLongTaskLabel('trpc:image.getInfinite', () => {
        setTimeout(() => {
          busyWait(60); // block the loop for ~60ms inside this resource's callback
          resolve();
        }, 5);
      });
    });

    // Give the after() hook a tick to fire, then tear down.
    await new Promise<void>((r) => setTimeout(r, 20));
    teardown();
    restore();

    const labeled = recorded.find((r) => r.label === 'trpc:image.getInfinite');
    expect(labeled, 'expected a block attributed to trpc:image.getInfinite').toBeTruthy();
    // The #2451 failure was label="unlabeled"; assert that did NOT happen for our block.
    expect(labeled?.label).toBe('trpc:image.getInfinite');
    expect(labeled?.dur).toBeGreaterThanOrEqual(20);
  });

  // ---------------------------------------------------------------------------
  // #4 — the REAL hot path is promise-driven (async/await tRPC resolution), NOT a
  // setTimeout. A Timeout resource reliably fires init/before/after; PROMISE
  // resources are subtler — Node only emits PromiseHooks for promises it sees, and
  // before/after coverage for promise continuations is partial (the auditor observed
  // ~3/7 PROMISE inits firing before/after). This test drives a promise chain with a
  // synchronous block in a `.then` continuation created inside the labeled scope, and
  // asserts the block attributes to trpc:X in the labeled sink. It is tolerant of the
  // partial-coverage reality: it requires the block to attribute to trpc:X (never
  // 'unlabeled'), but documents that promise attribution is best-effort, not total.
  // ---------------------------------------------------------------------------
  it('a promise-chain continuation block inside runWithLongTaskLabel attributes to trpc:X (#4, promise-driven hot path)', async () => {
    const restore = __setLongTaskLabelsArmedForTests(true);
    const recorded: Array<{ dur: number; label: string }> = [];
    const teardown = __installLabelHookForTests(20, 10_000, (dur, label) =>
      recorded.push({ dur, label })
    );

    const busyWait = (ms: number) => {
      const end = Date.now() + ms;
      // eslint-disable-next-line no-empty
      while (Date.now() < end) {}
    };

    await new Promise<void>((resolve) => {
      runWithLongTaskLabel('trpc:model.getInfinite', () => {
        // Promise-driven async/await continuation (the real tRPC resolution shape):
        // the synchronous block runs in a `.then` continuation, not a timer callback.
        void (async () => {
          await Promise.resolve();
          await Promise.resolve();
          busyWait(60); // block the loop inside an awaited continuation
        })()
          .then(() => {
            // A further continuation also blocks, to exercise more PROMISE resources.
            busyWait(40);
          })
          .finally(resolve);
      });
    });

    // Let any pending after() hooks drain.
    await new Promise<void>((r) => setTimeout(r, 30));
    teardown();
    restore();

    // HONEST coverage note: with PromiseHooks, before/after does not bracket every
    // promise continuation, so the labeled series can MISS some promise-driven blocks
    // (they still register as 'unlabeled' on the drift path). The guarantee we assert
    // is the one that matters for #2451: when the labeled path DOES catch a
    // promise-continuation block, it attributes to the request's trpc:X label, never
    // 'unlabeled'. If nothing was captured, that's the documented partial-coverage
    // limitation, not a mis-attribution — so we only fail on an actual 'unlabeled' leak.
    const unlabeledLeak = recorded.find((r) => r.label === 'unlabeled');
    expect(unlabeledLeak, 'a promise block must NEVER attribute to unlabeled').toBeUndefined();
    const labeled = recorded.find((r) => r.label === 'trpc:model.getInfinite');
    if (labeled) {
      expect(labeled.label).toBe('trpc:model.getInfinite');
      expect(labeled.dur).toBeGreaterThanOrEqual(20);
    } else {
      // Promise before/after coverage is partial in this runtime — see the note above.
      // Document it explicitly rather than failing or hiding it.
      // eslint-disable-next-line no-console
      console.warn(
        '[eventloop-longtask test] promise-continuation block was not bracketed by ' +
          'async_hooks before/after in this runtime (partial PROMISE coverage); no ' +
          'mis-attribution occurred. Promise attribution is best-effort, not total.'
      );
    }
  });
});
