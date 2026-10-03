import { describe, expect, it } from 'vitest';
import * as motionValues from '~/components/Apps/agentOnboardingMotion';
import {
  CARET_BLINK_TRANSITION,
  GLYPH_POP_ANIMATE,
  REVEAL_ANIMATE,
  REVEAL_INITIAL,
  STAGGER_SECONDS,
  revealTransition,
} from '~/components/Apps/agentOnboardingMotion';

/**
 * `AgentOnboardingCard`'s motion values, in the tier CI actually reads.
 *
 * 🔴 EVERY ASSERTION HERE REPLACES ONE THAT WAS VACUOUS. The browser suite used to assert
 * `STAGGER_SECONDS === 0.04` — an exported literal against itself — and nothing bound it to
 * the delay. Measured: flattening the stagger to `delay: 0`, and swapping the entrance to an
 * `opacity` fade, EACH left the entire 34-test browser suite green. These are the guards that
 * go red on both.
 */

describe('🔴 the entrance never animates opacity', () => {
  it('`initial` moves the row and hides nothing', () => {
    // The component's own correctness claim, which was documentation only. `m` renders
    // `initial` as a STATIC style, so an `opacity: 0` here ships invisible content in the
    // server-rendered HTML of the one indexable state of `/apps/build` — and it stays
    // invisible for as long as the lazy `motion` chunk takes, or forever if hydration never
    // completes.
    expect(REVEAL_INITIAL).toEqual({ y: 6 });
    expect(REVEAL_INITIAL).not.toHaveProperty('opacity');
    expect(REVEAL_ANIMATE).not.toHaveProperty('opacity');
  });

  it('and neither does it scale or fade the row by any other hiding key', () => {
    // Stated as a closed set rather than a list of forbidden names: anything beyond `y` is a
    // deliberate edit that should come back through this test.
    expect(Object.keys(REVEAL_INITIAL)).toEqual(['y']);
    expect(Object.keys(REVEAL_ANIMATE)).toEqual(['y']);
  });
});

describe('🔴 the stagger is the DELAY, not just the constant', () => {
  it('each row is one step later than the last', () => {
    expect(revealTransition(0).delay).toBeCloseTo(0);
    expect(revealTransition(1).delay).toBeCloseTo(0.04);
    expect(revealTransition(2).delay).toBeCloseTo(0.08);
  });

  it('the step is 40ms, and the delay is derived from it rather than retyped', () => {
    // Multiplying by the constant is what a flattening mutation breaks; asserting the
    // constant alone is what let one through.
    expect(STAGGER_SECONDS).toBe(0.04);
    expect(revealTransition(3).delay).toBeCloseTo(3 * STAGGER_SECONDS);
  });
});

describe('the decorative animations', () => {
  it('🔴 the glyph pop RETURNS TO REST', () => {
    // Re-added after being deleted as "a literal against itself" — it is not. It pins that
    // the keyframe track ENDS where it started: `scale: [1, 1.25, 1.1]` would leave the glyph
    // permanently 10% larger after every copy, a visible and permanent defect that nothing
    // else in this change catches (the browser suite only asserts the pop wrapper exists).
    expect(GLYPH_POP_ANIMATE.scale).toEqual([1, 1.25, 1]);
  });

  it('🔴 the only INFINITE animation on `motion` is the one framer can accelerate', () => {
    // 🔴 ENUMERATED OVER THE MODULE, NOT ASSERTED ABOUT ONE EXPORT. The name claims a
    // RELATIONSHIP — "the only one" — and an earlier version inspected a single side, so
    // adding e.g. `GLYPH_PULSE_TRANSITION = { repeat: Infinity }` over `scale` left it green
    // while reproducing the shimmer bug: a non-accelerable key on a `keepAlive` frameloop
    // driver that never unregisters.
    //
    // The caret is the one permitted member because its key is literally `opacity`, which IS
    // in framer's `acceleratedValues` ({opacity, clipPath, filter, transform}), and
    // `repeatType: 'reverse'` clears the gate that would force a main-thread animator.
    const infinite = Object.entries(motionValues)
      .filter(([, v]) => typeof v === 'object' && v !== null && 'repeat' in v)
      .filter(([, v]) => (v as { repeat?: number }).repeat === Infinity)
      .map(([name]) => name)
      .sort();
    expect(infinite).toEqual(['CARET_BLINK_TRANSITION']);
    expect(CARET_BLINK_TRANSITION.repeatType).toBe('reverse');
  });
});
