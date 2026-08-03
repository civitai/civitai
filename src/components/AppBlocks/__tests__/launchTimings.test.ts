import { describe, expect, it } from 'vitest';

import {
  boundedDeltaMs,
  boundedDurationMs,
  computeLaunchTimings,
  createLaunchMarks,
  matchIframeResourceEntry,
  MAX_LAUNCH_SAMPLE_MS,
  resetLaunchMarks,
  type LaunchMarks,
} from '../launchTimings';

/**
 * App Block LAUNCH-LATENCY math.
 *
 * These live in the node `unit` project deliberately: the browser (`component`)
 * project is NOT run in CI, and every rule here fails by producing a *plausible
 * wrong number* rather than an error — a zero that reads as an instant leg, a
 * clamped outlier that reads as a 30-second launch, a background-tab sample that
 * reads as a slow app. None of those would ever surface as a red test elsewhere.
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

describe('matchIframeResourceEntry', () => {
  const SRC = 'https://notepad.civit.ai/';

  it('matches the iframe document entry by URL and prefers its own `duration`', () => {
    expect(
      matchIframeResourceEntry(SRC, [
        { name: 'https://civitai.com/_next/static/chunk.js', duration: 900 },
        { name: SRC, duration: 214, startTime: 100, responseEnd: 999 },
      ])
    ).toEqual({ durationMs: 214 });
  });

  it('falls back to responseEnd - startTime when duration is absent or zero', () => {
    expect(
      matchIframeResourceEntry(SRC, [{ name: SRC, startTime: 100, responseEnd: 342 }])
    ).toEqual({ durationMs: 242 });
    expect(
      matchIframeResourceEntry(SRC, [{ name: SRC, duration: 0, startTime: 100, responseEnd: 342 }])
    ).toEqual({ durationMs: 242 });
  });

  it('ignores the URL fragment when matching', () => {
    expect(
      matchIframeResourceEntry('https://notepad.civit.ai/#/note/1', [{ name: SRC, duration: 50 }])
    ).toEqual({ durationMs: 50 });
  });

  it('takes the LAST match (a re-keyed iframe on the Retry path adds a second entry)', () => {
    expect(
      matchIframeResourceEntry(SRC, [
        { name: SRC, duration: 111 },
        { name: SRC, duration: 222 },
      ])
    ).toEqual({ durationMs: 222 });
  });

  it('returns null when the iframe entry is absent (the ~250-entry buffer overflowed)', () => {
    expect(matchIframeResourceEntry(SRC, [{ name: 'https://civitai.com/x.js', duration: 5 }])).toBe(
      null
    );
    expect(matchIframeResourceEntry(SRC, [])).toBe(null);
  });

  it('does not match a DIFFERENT app on the same apex domain', () => {
    expect(
      matchIframeResourceEntry(SRC, [{ name: 'https://gen-matrix.civit.ai/', duration: 5 }])
    ).toBe(null);
  });

  it('skips malformed entries without throwing', () => {
    expect(
      matchIframeResourceEntry(SRC, [
        { name: 42 as unknown as string },
        {},
        { name: SRC, duration: 7 },
      ])
    ).toEqual({ durationMs: 7 });
  });
});

describe('computeLaunchTimings', () => {
  it('emits all four legs on a complete, visible launch', () => {
    expect(computeLaunchTimings(marks(), { durationMs: 320 })).toEqual({
      totalMs: 1_100, // 2100 - 1000
      tokenMintMs: 180, // 1180 - 1000
      frameFetchMs: 320,
      initWaitMs: 700, // 2100 - 1400
    });
  });

  it('🔴 does NOT enforce (or care) that the phases sum to the total — they are PARALLEL', () => {
    // token_mint (180) + frame_fetch (900) + init_wait (700) = 1780 > total 1100.
    // That is not a bug: the mint races the cross-origin frame load, because the
    // iframe mounts on the first client render before any token exists. A guard
    // that rejected this would silently drop every real sample.
    const out = computeLaunchTimings(marks(), { durationMs: 900 });
    expect(out).toEqual({ totalMs: 1_100, tokenMintMs: 180, frameFetchMs: 900, initWaitMs: 700 });
    const sum = out!.tokenMintMs! + out!.frameFetchMs! + out!.initWaitMs!;
    expect(sum).toBeGreaterThan(out!.totalMs);
  });

  it('🔴 drops the WHOLE sample when the tab was ever hidden', () => {
    // Identical marks, one flag flipped — so this cannot pass for another reason.
    expect(computeLaunchTimings(marks({ wasHidden: false }), { durationMs: 320 })).not.toBe(null);
    expect(computeLaunchTimings(marks({ wasHidden: true }), { durationMs: 320 })).toBe(null);
  });

  it('drops the sample when BLOCK_READY never arrived (a failure has no launch time)', () => {
    expect(computeLaunchTimings(marks({ readyAt: null }), { durationMs: 320 })).toBe(null);
  });

  it('drops the sample on the server, where there is no clock (mountedAt null)', () => {
    expect(computeLaunchTimings(marks({ mountedAt: null }), { durationMs: 320 })).toBe(null);
  });

  it('🔴 `total` is the ANCHOR: an out-of-range total drops every phase with it', () => {
    const out = computeLaunchTimings(
      marks({ mountedAt: 0, readyAt: MAX_LAUNCH_SAMPLE_MS + 1, tokenAt: 180, initSentAt: 400 }),
      { durationMs: 320 }
    );
    expect(out).toBe(null);
  });

  it('accepts a total exactly AT the bound and rejects one millisecond past it', () => {
    expect(
      computeLaunchTimings(
        {
          mountedAt: 0,
          tokenAt: null,
          initSentAt: null,
          readyAt: MAX_LAUNCH_SAMPLE_MS,
          wasHidden: false,
        },
        null
      )
    ).toEqual({ totalMs: MAX_LAUNCH_SAMPLE_MS });
    expect(
      computeLaunchTimings(
        {
          mountedAt: 0,
          tokenAt: null,
          initSentAt: null,
          readyAt: MAX_LAUNCH_SAMPLE_MS + 1,
          wasHidden: false,
        },
        null
      )
    ).toBe(null);
  });

  it('🔴 OMITS a zero-length leg instead of emitting 0 (token already present at mount)', () => {
    const out = computeLaunchTimings(marks({ tokenAt: BASE_MARKS.mountedAt }), { durationMs: 320 });
    expect(out).not.toBe(null);
    expect(out).not.toHaveProperty('tokenMintMs');
    // …and the rest of the sample survives — one missing leg is not a drop.
    expect(out).toMatchObject({ totalMs: 1_100, frameFetchMs: 320, initWaitMs: 700 });
  });

  it('🔴 OMITS frame_fetch when there is no resource entry — never a zero', () => {
    const out = computeLaunchTimings(marks(), null);
    expect(out).not.toHaveProperty('frameFetchMs');
    expect(out).toMatchObject({ totalMs: 1_100, tokenMintMs: 180, initWaitMs: 700 });
  });

  it('🔴 OMITS frame_fetch on a zero/negative duration — never a zero', () => {
    expect(computeLaunchTimings(marks(), { durationMs: 0 })).not.toHaveProperty('frameFetchMs');
    expect(computeLaunchTimings(marks(), { durationMs: -3 })).not.toHaveProperty('frameFetchMs');
  });

  it('drops ONLY the offending phase when a phase is out of range, keeping the total', () => {
    const out = computeLaunchTimings(marks(), { durationMs: MAX_LAUNCH_SAMPLE_MS + 1 });
    expect(out).toEqual({ totalMs: 1_100, tokenMintMs: 180, initWaitMs: 700 });
  });

  it('omits init_wait when BLOCK_INIT was never posted, keeping total and token_mint', () => {
    const out = computeLaunchTimings(marks({ initSentAt: null }), null);
    expect(out).toEqual({ totalMs: 1_100, tokenMintMs: 180 });
  });

  it('emits a bare total when only the mount and ready marks exist', () => {
    expect(
      computeLaunchTimings(
        { mountedAt: 10, tokenAt: null, initSentAt: null, readyAt: 910, wasHidden: false },
        null
      )
    ).toEqual({ totalMs: 900 });
  });
});
