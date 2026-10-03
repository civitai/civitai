import { describe, expect, it } from 'vitest';
import {
  CARET_BLINK_TRANSITION,
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

  it('POSITIVE CONTROL: the delays are distinct, so a zeroed stagger is observable', () => {
    // Without this, every assertion above is satisfied by a function returning 0 for the
    // indices that happen to be tested — and index 0 legitimately IS 0.
    const delays = [0, 1, 2].map((i) => revealTransition(i).delay);
    expect(new Set(delays).size).toBe(3);
  });
});

describe('the decorative animations', () => {
  it('🔴 the only INFINITE animation on `motion` is the one framer can accelerate', () => {
    // The caret animates `opacity`, which is literally in framer's `acceleratedValues`
    // ({opacity, clipPath, filter, transform}), and `repeatType: 'reverse'` clears the gate
    // that would force a main-thread animator — so it runs compositor-side. The shimmer was
    // moved to CSS precisely because `background-position` is not in that set and WAS
    // infinite. If a second infinite `motion` animation is ever added here, this is the test
    // that should make someone check which animator it gets.
    expect(CARET_BLINK_TRANSITION.repeat).toBe(Infinity);
    expect(CARET_BLINK_TRANSITION.repeatType).toBe('reverse');
  });
});
