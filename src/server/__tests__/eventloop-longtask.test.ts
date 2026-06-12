import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the prom + logging deps so the module under test imports cleanly without
// booting prom-client registries or the Axiom logger. These mocks are inert; the
// tests here exercise the pure drift math and the disarmed-passthrough guarantee.
// ---------------------------------------------------------------------------
// The module-under-test registers its metrics into the cross-graph shared
// `instrumentationRegistry`. Give it a real throwaway registry so the module imports
// cleanly here; metric EMISSION is asserted against a real registry in the sibling
// eventloop-longtask-metrics.test.ts. This suite focuses on drift math + the
// disarmed-passthrough guarantee.
const { driftTestRegistry } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const promClient = require('prom-client');
  return { driftTestRegistry: new promClient.Registry() };
});

vi.mock('~/server/prom/client', () => ({
  registerCounter: () => ({ inc: vi.fn() }),
  registerHistogram: () => ({ observe: vi.fn() }),
  instrumentationRegistry: driftTestRegistry,
  registerInstrumentationMetric: (name: string, factory: () => unknown) => {
    const existing = driftTestRegistry.getSingleMetric(name);
    return existing ?? factory();
  },
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

import {
  classifyDrift,
  runWithLongTaskLabel,
  longTaskLabelsArmed,
  __setLongTaskLabelsArmedForTests,
  __hasActiveLabelStoreForTests,
} from '~/server/eventloop-longtask';

describe('eventloop-longtask: disarmed passthrough is wrapper-free', () => {
  beforeEach(() => {
    // Ensure each test starts from the disarmed default.
    __setLongTaskLabelsArmedForTests(false);
  });

  it('defaults to disarmed (labels tier off) at module load', () => {
    expect(longTaskLabelsArmed).toBe(false);
  });

  it('returns the thunk result directly without creating an ALS store when disarmed', () => {
    const restore = __setLongTaskLabelsArmedForTests(false);

    const sentinel = { value: 42 };
    let storeDuringRun: boolean | undefined;

    const result = runWithLongTaskLabel('trpc:test.path', () => {
      // Inside the thunk, NO ALS store must be active in the disarmed path.
      storeDuringRun = __hasActiveLabelStoreForTests();
      return sentinel;
    });

    restore();

    // Same object reference back — no wrapping/copy.
    expect(result).toBe(sentinel);
    // Proves runWithLongTaskLabel did NOT call labelStorage.run() (no store).
    expect(storeDuringRun).toBe(false);
  });

  it('preserves the thunk return value type/identity through the passthrough', () => {
    __setLongTaskLabelsArmedForTests(false);
    const arr = [1, 2, 3];
    expect(runWithLongTaskLabel('x', () => arr)).toBe(arr);
    expect(runWithLongTaskLabel('x', () => 'literal')).toBe('literal');
  });

  it('DOES create an ALS store and reads the label back when the labels tier is armed', () => {
    const restore = __setLongTaskLabelsArmedForTests(true);

    let storeDuringRun: boolean | undefined;
    runWithLongTaskLabel('trpc:armed.path', () => {
      storeDuringRun = __hasActiveLabelStoreForTests();
    });
    // After the run scope exits there must be no leaked store.
    const storeAfter = __hasActiveLabelStoreForTests();

    restore();

    expect(storeDuringRun).toBe(true);
    expect(storeAfter).toBe(false);
  });
});

describe('eventloop-longtask: drift math', () => {
  const TICK = 20;
  const THRESHOLD = 50;
  const SUSPEND_CAP = 5000;

  it('classifies a normal tick (no excess) as ok', () => {
    // gap == tick => blockedMs 0
    const r = classifyDrift(1020, 1000, TICK, THRESHOLD, SUSPEND_CAP);
    expect(r).toEqual({ kind: 'ok', blockedMs: 0 });
  });

  it('classifies a small excess below threshold as ok', () => {
    // gap 60ms => blockedMs 40, below 50 threshold
    const r = classifyDrift(1060, 1000, TICK, THRESHOLD, SUSPEND_CAP);
    expect(r).toEqual({ kind: 'ok', blockedMs: 40 });
  });

  it('computes blockedMs correctly for a real block', () => {
    // gap 320ms => blockedMs = 320 - 20 = 300, at/over threshold, under cap
    const r = classifyDrift(1320, 1000, TICK, THRESHOLD, SUSPEND_CAP);
    expect(r).toEqual({ kind: 'block', blockedMs: 300 });
  });

  it('treats exactly-threshold excess as a block (inclusive)', () => {
    // gap 70ms => blockedMs 50 == threshold
    const r = classifyDrift(1070, 1000, TICK, THRESHOLD, SUSPEND_CAP);
    expect(r).toEqual({ kind: 'block', blockedMs: 50 });
  });

  it('reclassifies an absurd multi-second gap as suspension, not a JS block', () => {
    // gap 8000ms => blockedMs 7980 >= 5000 cap => suspension (descheduled pod)
    const r = classifyDrift(9000, 1000, TICK, THRESHOLD, SUSPEND_CAP);
    expect(r).toEqual({ kind: 'suspension', gapMs: 8000 });
  });

  it('treats exactly-cap excess as suspension (inclusive cap boundary)', () => {
    // blockedMs == 5000 exactly => suspension
    const r = classifyDrift(1000 + TICK + SUSPEND_CAP, 1000, TICK, THRESHOLD, SUSPEND_CAP);
    expect(r).toEqual({ kind: 'suspension', gapMs: TICK + SUSPEND_CAP });
  });

  it('a gap just under the cap is still a block', () => {
    // blockedMs 4999 < 5000 => block
    const r = classifyDrift(1000 + TICK + 4999, 1000, TICK, THRESHOLD, SUSPEND_CAP);
    expect(r).toEqual({ kind: 'block', blockedMs: 4999 });
  });

  it('disables the suspension cap when suspendCapMs <= 0 (huge gap is a block)', () => {
    const r = classifyDrift(60000, 1000, TICK, THRESHOLD, 0);
    expect(r).toEqual({ kind: 'block', blockedMs: 60000 - 1000 - TICK });
  });
});
