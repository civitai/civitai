import { describe, expect, it } from 'vitest';

import {
  boundedDeltaMs,
  boundedDurationMs,
  computeLaunchTimings,
  createLaunchMarks,
  MAX_LAUNCH_SAMPLE_MS,
  resetLaunchMarks,
  shouldResetLaunchMarks,
  type LaunchMarks,
} from '../launchTimings';

/**
 * App Block LAUNCH-LATENCY math.
 *
 * These live in the node `unit` project deliberately: the browser (`component`)
 * project is NOT run in CI, and every rule here fails by producing a *plausible
 * wrong number* rather than an error — a zero that reads as an instant leg, a
 * clamped outlier that reads as a 60-second launch, a background-tab sample that
 * reads as a slow app, a t0 quietly reset a few milliseconds late. None of those
 * would ever surface as a red test elsewhere.
 */

const BASE_MARKS: LaunchMarks = {
  mountedAt: 1_000,
  tokenAt: 1_180,
  initSentAt: 1_400,
  readyAt: 2_100,
  wasHidden: false,
};

const marks = (over: Partial<LaunchMarks> = {}): LaunchMarks => ({ ...BASE_MARKS, ...over });

describe('boundedDurationMs / boundedDeltaMs — the two gates', () => {
  it('🔴 NEVER returns a zero (an unobserved leg must not read as an instant one)', () => {
    expect(boundedDurationMs(0)).toBeUndefined();
    expect(boundedDurationMs(-5)).toBeUndefined();
    // Sub-millisecond noise rounds to 0 and is likewise dropped, not emitted.
    expect(boundedDurationMs(0.4)).toBeUndefined();
    expect(boundedDeltaMs(1_000, 1_000)).toBeUndefined();
    expect(boundedDeltaMs(1_000, 999)).toBeUndefined();
  });

  it('🔴 DROPS an out-of-range sample rather than clamping it to the bound', () => {
    expect(boundedDurationMs(MAX_LAUNCH_SAMPLE_MS)).toBe(MAX_LAUNCH_SAMPLE_MS);
    expect(boundedDurationMs(MAX_LAUNCH_SAMPLE_MS + 1)).toBeUndefined();
    // The failure mode this pins: a clamp would return MAX here and fold junk
    // onto the +Inf edge, polluting _sum and every tail quantile.
    expect(boundedDurationMs(9_999_999)).toBeUndefined();
  });

  /**
   * 🔴 THE BOUND MUST CLEAR THE AUTO-RETRY WORST CASE.
   *
   * The host emits ONE `ok` for the whole bounded auto-retry sequence, whichever
   * attempt produced it — so a legitimate success can be ~47s
   * (15 no_token + 2 backoff + 15 no_token + 5 backoff + ~10 ready). The
   * previous 30s bound silently DROPPED those, and the drop was
   * slowness-correlated: it trimmed exactly the tail the metric exists to show.
   * A value pin, not a tautology — it goes red if the bound is lowered back.
   */
  it('🔴 accepts a slow auto-retry success (~47s), which the old 30s bound dropped', () => {
    expect(boundedDurationMs(47_000)).toBe(47_000);
    expect(boundedDurationMs(30_001)).toBe(30_001);
    expect(MAX_LAUNCH_SAMPLE_MS).toBeGreaterThan(47_000);
  });

  it('rejects non-finite and non-numeric inputs', () => {
    expect(boundedDurationMs(Number.NaN)).toBeUndefined();
    expect(boundedDurationMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(boundedDurationMs(null)).toBeUndefined();
    expect(boundedDurationMs(undefined)).toBeUndefined();
    expect(boundedDeltaMs(null, 500)).toBeUndefined();
    expect(boundedDeltaMs(500, null)).toBeUndefined();
    expect(boundedDeltaMs(Number.NaN, 500)).toBeUndefined();
  });

  it('rounds to whole milliseconds', () => {
    expect(boundedDurationMs(12.4)).toBe(12);
    expect(boundedDurationMs(12.6)).toBe(13);
    expect(boundedDeltaMs(1_000.2, 1_012.9)).toBe(13);
  });
});

describe('createLaunchMarks / resetLaunchMarks', () => {
  it('starts every mark null except the mount stamp', () => {
    const m = createLaunchMarks(42, false);
    expect(m).toEqual({
      mountedAt: 42,
      tokenAt: null,
      initSentAt: null,
      readyAt: null,
      wasHidden: false,
    });
  });

  it('carries an already-hidden tab through from creation', () => {
    expect(createLaunchMarks(42, true).wasHidden).toBe(true);
  });

  it('re-arms IN PLACE for a new block instance (host reuse on soft nav)', () => {
    const m = createLaunchMarks(0, true);
    m.tokenAt = 10;
    m.initSentAt = 20;
    m.readyAt = 30;
    const same = m;
    resetLaunchMarks(m, 500, false);
    // Same object identity — callers hold this in a ref.
    expect(same).toBe(m);
    expect(m).toEqual({
      mountedAt: 500,
      tokenAt: null,
      initSentAt: null,
      readyAt: null,
      wasHidden: false,
    });
  });
});

/**
 * 🔴 THE FIRST-MOUNT GUARD.
 *
 * The host's re-arm effect is keyed on `[blockInstanceId]`, and such an effect
 * ALSO RUNS ON FIRST MOUNT. Resetting unconditionally there overwrites the
 * render-time `mountedAt` — taken in the commit where the iframe actually mounts
 * — with a post-commit timestamp, silently shortening EVERY `total` by the
 * render->effect gap. Nothing breaks and no other test goes red; the number is
 * just quietly flattering.
 *
 * The gap is milliseconds in a harness and much larger on a real cold load, so a
 * browser test cannot discriminate it by magnitude. This is where it is pinned.
 */
describe('shouldResetLaunchMarks', () => {
  /**
   * INVARIANT GUARD, not regression coverage: the host seeds `launchInstanceRef`
   * at render time, so `previousInstanceId` is never actually `null` by the time
   * the effect runs. This pins the predicate's contract for any future caller
   * that does not seed eagerly; the real first-mount protection is the WIRING,
   * gated in launchSampleBound.test.ts.
   */
  it('🔴 does NOT reset on first mount (there is no previous instance)', () => {
    expect(shouldResetLaunchMarks(null, 'page_apb_a')).toBe(false);
  });

  it('does NOT reset when the effect re-runs for the SAME instance', () => {
    expect(shouldResetLaunchMarks('page_apb_a', 'page_apb_a')).toBe(false);
  });

  it('DOES reset on a soft nav to a different app instance', () => {
    expect(shouldResetLaunchMarks('page_apb_a', 'page_apb_b')).toBe(true);
  });
});

describe('computeLaunchTimings', () => {
  it('emits both host-side legs plus the total on a complete, visible launch', () => {
    expect(computeLaunchTimings(marks())).toEqual({
      totalMs: 1_100, // 2100 - 1000
      tokenMintMs: 180, // 1180 - 1000
      initWaitMs: 700, // 2100 - 1400
    });
  });

  it('🔴 does NOT enforce (or care) that the phases sum to the total — they are PARALLEL', () => {
    // Here token_mint (900) + init_wait (1050) exceeds the total (1100). That is
    // not a bug: the mint races the cross-origin frame load, because the iframe
    // mounts on the first client render before any token exists. A guard that
    // assumed a serial sum would silently drop real samples.
    const out = computeLaunchTimings(marks({ tokenAt: 1_900, initSentAt: 1_050 }))!;
    expect(out).toEqual({ totalMs: 1_100, tokenMintMs: 900, initWaitMs: 1_050 });
    expect(out.tokenMintMs! + out.initWaitMs!).toBeGreaterThan(out.totalMs);
  });

  it('🔴 drops the WHOLE sample when the tab was ever hidden', () => {
    // Identical marks, one flag flipped — so this cannot pass for another reason.
    expect(computeLaunchTimings(marks({ wasHidden: false }))).not.toBe(null);
    expect(computeLaunchTimings(marks({ wasHidden: true }))).toBe(null);
  });

  it('drops the sample when BLOCK_READY never arrived (a failure has no launch time)', () => {
    expect(computeLaunchTimings(marks({ readyAt: null }))).toBe(null);
  });

  it('drops the sample on the server, where there is no clock (mountedAt null)', () => {
    expect(computeLaunchTimings(marks({ mountedAt: null }))).toBe(null);
  });

  it('🔴 `total` is the ANCHOR: an out-of-range total drops every phase with it', () => {
    expect(
      computeLaunchTimings(
        marks({ mountedAt: 0, readyAt: MAX_LAUNCH_SAMPLE_MS + 1, tokenAt: 180, initSentAt: 400 })
      )
    ).toBe(null);
  });

  it('accepts a total exactly AT the bound and rejects one millisecond past it', () => {
    expect(
      computeLaunchTimings({
        mountedAt: 0,
        tokenAt: null,
        initSentAt: null,
        readyAt: MAX_LAUNCH_SAMPLE_MS,
        wasHidden: false,
      })
    ).toEqual({ totalMs: MAX_LAUNCH_SAMPLE_MS });
    expect(
      computeLaunchTimings({
        mountedAt: 0,
        tokenAt: null,
        initSentAt: null,
        readyAt: MAX_LAUNCH_SAMPLE_MS + 1,
        wasHidden: false,
      })
    ).toBe(null);
  });

  it('🔴 OMITS a zero-length leg instead of emitting 0 (token already present at mount)', () => {
    const out = computeLaunchTimings(marks({ tokenAt: BASE_MARKS.mountedAt }));
    expect(out).not.toBe(null);
    expect(out).not.toHaveProperty('tokenMintMs');
    // …and the rest of the sample survives — one missing leg is not a drop.
    expect(out).toMatchObject({ totalMs: 1_100, initWaitMs: 700 });
  });

  it('omits init_wait when BLOCK_INIT was never posted, keeping total and token_mint', () => {
    expect(computeLaunchTimings(marks({ initSentAt: null }))).toEqual({
      totalMs: 1_100,
      tokenMintMs: 180,
    });
  });

  it('emits a bare total when only the mount and ready marks exist', () => {
    expect(
      computeLaunchTimings({
        mountedAt: 10,
        tokenAt: null,
        initSentAt: null,
        readyAt: 910,
        wasHidden: false,
      })
    ).toEqual({ totalMs: 900 });
  });

  /**
   * Guard on the DELIBERATE ABSENCE of a cross-origin frame phase. Without
   * `Timing-Allow-Origin` the parent's `responseEnd` for a subframe is the
   * frame's LOAD event rather than the document response, so a `frame_fetch`
   * built on it measures roughly what `total` already measures — and the entry
   * often does not exist yet when the beacon fires. Anyone re-adding the phase
   * must read the DEFERRED note in launchTimings.ts first; this pins that the
   * wire shape carries no such field today.
   */
  it('never emits a frameFetchMs field (the cross-origin phase is deliberately deferred)', () => {
    const out = computeLaunchTimings(marks())!;
    expect(out).not.toHaveProperty('frameFetchMs');
    expect(Object.keys(out).sort()).toEqual(['initWaitMs', 'tokenMintMs', 'totalMs']);
  });
});
