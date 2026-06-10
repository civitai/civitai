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
const HISTOGRAM = PREFIX + 'eventloop_longtask_duration_seconds';

async function histogramCount(name: string, label: string): Promise<number> {
  const metric = labelsTestRegistry.getSingleMetric(name) as client.Histogram<string> | undefined;
  if (!metric) return NaN;
  const { values } = await metric.get();
  const countSeries = values.find(
    (v) => v.metricName === `${name}_count` && v.labels.label === label
  );
  return countSeries?.value ?? 0;
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

describe('eventloop-longtask labels: recordLabeledBlock reaches the REGISTERED histogram', () => {
  const opts = { logMinMs: 50, threshold: 50, logPerMin: 0 };

  it('observes the histogram under the trpc:* label (not unlabeled)', async () => {
    const before = await histogramCount(HISTOGRAM, 'trpc:model.getById');
    recordLabeledBlock(310, 'trpc:model.getById', opts);
    const after = await histogramCount(HISTOGRAM, 'trpc:model.getById');
    expect(after).toBe(before + 1);

    const scraped = await labelsTestRegistry.getSingleMetricAsString(HISTOGRAM);
    expect(scraped).toContain('label="trpc:model.getById"');
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
});
