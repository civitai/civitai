import { describe, it, expect } from 'vitest';

import { shouldTriggerLagCapture } from '~/server/cpu-profiler';

// These tests exercise the PURE trigger-decision function in isolation. The
// actual capture needs a real node:inspector Session (separate-thread V8
// sampler), so we never profile for real here — the watchdog timer's only
// non-trivial logic (given a max-lag reading + env config + cooldown/in-progress
// state, should we fire?) is factored into shouldTriggerLagCapture and tested
// directly. We do NOT test perf_hooks/monitorEventLoopDelay internals.

describe('cpu-profiler: shouldTriggerLagCapture (lag self-trigger decision)', () => {
  // A sane armed baseline; individual tests override one field at a time.
  const base = {
    maxLagMs: 1500,
    triggerMs: 1000,
    capturing: false,
    nowMs: 100_000,
    cooldownUntilMs: 0,
  };

  it('triggers when lag is at or above the threshold (and otherwise clear)', () => {
    expect(shouldTriggerLagCapture(base)).toBe(true);
    // Exactly at threshold is inclusive.
    expect(shouldTriggerLagCapture({ ...base, maxLagMs: 1000 })).toBe(true);
  });

  it('does NOT trigger when lag is below the threshold', () => {
    expect(shouldTriggerLagCapture({ ...base, maxLagMs: 999 })).toBe(false);
    expect(shouldTriggerLagCapture({ ...base, maxLagMs: 0 })).toBe(false);
  });

  it('does NOT trigger when disabled (triggerMs <= 0), even with huge lag', () => {
    expect(shouldTriggerLagCapture({ ...base, triggerMs: 0, maxLagMs: 100_000 })).toBe(false);
    expect(shouldTriggerLagCapture({ ...base, triggerMs: -1, maxLagMs: 100_000 })).toBe(false);
  });

  it('does NOT trigger while a capture is already in progress (in-progress guard)', () => {
    // This is the guard shared with the SIGWINCH path: signal and auto-trigger
    // must never overlap.
    expect(shouldTriggerLagCapture({ ...base, capturing: true })).toBe(false);
  });

  it('does NOT trigger inside the post-capture cooldown window', () => {
    // now=100000 < cooldownUntil=160000 → suppressed even though lag is high.
    expect(shouldTriggerLagCapture({ ...base, cooldownUntilMs: 160_000 })).toBe(false);
  });

  it('triggers again once the cooldown window has elapsed', () => {
    // now == cooldownUntil → cooldown has elapsed (boundary is inclusive: not <).
    expect(shouldTriggerLagCapture({ ...base, nowMs: 160_000, cooldownUntilMs: 160_000 })).toBe(
      true
    );
    // now just past the window.
    expect(shouldTriggerLagCapture({ ...base, nowMs: 160_001, cooldownUntilMs: 160_000 })).toBe(
      true
    );
  });

  it('the in-progress guard takes precedence over an otherwise-fireable reading', () => {
    expect(
      shouldTriggerLagCapture({ ...base, maxLagMs: 50_000, capturing: true, cooldownUntilMs: 0 })
    ).toBe(false);
  });
});
