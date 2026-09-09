import { afterEach, describe, expect, test } from 'vitest';
import { INJECTED_ROOT_PROPERTIES } from '../../../../test/component-setup';

/**
 * The `--safe-area-inset-*` layer added alongside `viewport-fit=cover` must be a
 * LIVE indirection in a real browser: a `var()` that resolves to a length, that
 * a call site can compose into `calc()`/`max()`, and that tracks the value on
 * `:root`.
 *
 * 🔴 WHAT THIS FILE CAN AND CANNOT OBSERVE — read this before extending it.
 *
 * It CANNOT observe a notch. No headless browser reports a display cutout, so
 * `env(safe-area-inset-bottom)` is 0 here and always will be. Whether content
 * actually clears the status bar or the home indicator is a DEVICE question and
 * nothing in this repo has answered it.
 *
 * It CANNOT observe the Tailwind call sites either, and this is the trap worth
 * writing down. `test/component-setup.tsx` deliberately injects ONLY the `:root`
 * custom properties from `globals.css` and NOT the cascade (importing the real
 * stylesheet re-lays-out all ~2079 existing component tests — the reasoning is
 * in that file). So no `pb-[…]` utility class has a rule in this document, and
 * `getComputedStyle` on a component carrying one reads `0px` whether the class
 * is right, wrong, or absent. A "computed padding" assertion against
 * `ConsentBanner` or `AppFooter` here would be a probe wired to nothing that
 * passes on deleted code. Which components carry which class is pinned
 * STRUCTURALLY instead, by the ledger in
 * `src/components/Meta/__tests__/viewport-fit-cover.test.ts` (gating tier).
 *
 * What it CAN observe is the mechanism those call sites all depend on, which is
 * where the non-obvious CSS risk actually lives: that the property resolves at
 * all rather than being dropped, and that `max(<rem>, var(…))` — the idiom at
 * most of the call sites — picks the right operand in both directions.
 *
 * 🔴 WHY EVERY ASSERTION BELOW USES `calc()`/`max()` AND NEVER A BARE
 * `padding: var(--safe-area-inset-bottom)` EXPECTING `0px`. An unresolvable
 * `var()` makes the declaration invalid at computed-value time, so
 * `padding-bottom` falls back to its INITIAL value — `0px`. That is byte-identical
 * to a perfectly working property on a device with no cutout, so the obvious
 * assertion (`expect(padding).toBe('0px')`) passes just as happily when the
 * property does not exist at all. `width: calc(100px + var(…))` does not have
 * that ambiguity: resolved gives `100px`, dropped gives `auto` and fills the
 * parent. Each test below carries the undefined-property control alongside.
 *
 * This suite lives in `preview / component-tests`, which is REPORT-ONLY and red
 * on `main` independently of this change, so it informs and does not gate.
 *
 * 🔴 RED-AT-BASE MATRIX — MEASURED, NOT ASSERTED. Ran with the four
 * `--safe-area-inset-*` declarations deleted from `globals.css` (i.e. the tree as
 * `origin/main` has it), real Chromium 149: **5 failed | 5 passed (10)**.
 *
 *   RED at base (genuine regression coverage — 5):
 *     · all four properties are injected into the component-test document
 *     · --safe-area-inset-{top,right,bottom,left} composes into calc()
 *
 *   GREEN at base — INVARIANT GUARDS, NOT REGRESSION COVERAGE (5):
 *     · the control: an UNDEFINED property in the same calc is dropped
 *     · an override on :root reaches a consumer
 *     · 0.75rem is 12px in this document
 *     · the design padding wins when the inset is smaller
 *     · the inset wins when it is larger
 *
 *   Those five set `--safe-area-inset-bottom` on `:root` themselves (or measure
 *   plain CSS semantics), so they never read `globals.css` and cannot fail for
 *   the absence this change fixes. They are here to characterise the `max()`
 *   idiom and to keep the controls honest — do NOT count them as coverage of the
 *   change. Each is marked `INVARIANT GUARD` at its own site.
 */

const root = document.documentElement;
const OVERRIDDEN = '--safe-area-inset-bottom';

afterEach(() => {
  root.style.removeProperty(OVERRIDDEN);
});

/** Computed value of `property` on a throwaway element carrying `declaration`. */
function computed(declaration: string, property: 'width' | 'paddingBottom'): string {
  const el = document.createElement('div');
  el.setAttribute('style', declaration);
  document.body.appendChild(el);
  try {
    return getComputedStyle(el)[property];
  } finally {
    el.remove();
  }
}

describe('the --safe-area-inset-* layer resolves in a real browser', () => {
  test('all four properties are injected into the component-test document', () => {
    // The `:root` extraction is what makes every other test in the suite see
    // these at all. If it stopped picking them up, the assertions below would
    // start measuring an undefined property — i.e. they would become their own
    // negative control and silently invert.
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      expect(
        INJECTED_ROOT_PROPERTIES,
        `--safe-area-inset-${edge} is not reaching the test document, so every measurement ` +
          'below is against an undefined property rather than against the real layer.'
      ).toContain(`--safe-area-inset-${edge}`);
    }
  });

  test.each(['top', 'right', 'bottom', 'left'])(
    '--safe-area-inset-%s composes into calc() instead of being dropped',
    (edge) => {
      // Positive: the property resolves, so the calc yields a real length.
      expect(
        computed(`width: calc(100px + var(--safe-area-inset-${edge}))`, 'width'),
        `--safe-area-inset-${edge} did not resolve — the calc was dropped. Its env() fallback ` +
          'is missing or malformed, which means every consumer of this property loses its ' +
          'whole declaration rather than falling back to 0.'
      ).toBe('100px');
    }
  );

  // INVARIANT GUARD (green at base): plain CSS semantics, independent of globals.css.
  test('the control: an UNDEFINED property in the same calc is dropped', () => {
    // Without this, the four assertions above prove only that some number came
    // back. This is the arm that shows they can tell resolved from dropped.
    const dropped = computed('width: calc(100px + var(--safe-area-inset-nope))', 'width');
    expect(
      dropped,
      'an undefined custom property produced a resolved width, so the measurement above cannot ' +
        'distinguish a working property from a missing one and proves nothing.'
    ).not.toBe('100px');
  });

  // INVARIANT GUARD (green at base): sets the property itself, so it never reads globals.css.
  test('an override on :root reaches a consumer, so the indirection is live', () => {
    // The whole reason the call sites go through `var()` rather than `env()`:
    // `env()` cannot be simulated, this can. If this fails, the layer is being
    // constant-folded somewhere and no test can ever exercise a non-zero inset.
    root.style.setProperty(OVERRIDDEN, '34px');
    expect(computed('padding-bottom: var(--safe-area-inset-bottom)', 'paddingBottom')).toBe('34px');
  });

  describe('the max(<design padding>, <inset>) idiom used at most call sites', () => {
    // Pinned, not derived: `0.75rem` is `p-3`, the padding ConsentBanner and
    // StickerPlacementTray already had. Asserted first so that a change to the
    // document's root font size fails HERE, with this message, instead of making
    // the two directional assertions below look like a broken max().
    // INVARIANT GUARD (green at base): a precondition on the document, not on the change.
    test('0.75rem is 12px in this document', () => {
      expect(
        computed('padding-bottom: 0.75rem', 'paddingBottom'),
        'the root font size is not 16px in the component-test document, so the 12px expectations ' +
          'below are describing a different document than the one they were written for.'
      ).toBe('12px');
    });

    // INVARIANT GUARD (green at base): sets the property itself; characterises max(), not the fix.
    test('the design padding wins when the inset is smaller', () => {
      root.style.setProperty(OVERRIDDEN, '0px');
      expect(
        computed('padding-bottom: max(0.75rem, var(--safe-area-inset-bottom))', 'paddingBottom'),
        'on a device with no cutout the element must keep its original 12px, not collapse to 0.'
      ).toBe('12px');
    });

    // INVARIANT GUARD (green at base): sets the property itself; characterises max(), not the fix.
    test('the inset wins when it is larger', () => {
      // 34px is the iOS home-indicator inset — the case the whole change exists
      // for, and the one no headless browser will ever produce on its own.
      root.style.setProperty(OVERRIDDEN, '34px');
      expect(
        computed('padding-bottom: max(0.75rem, var(--safe-area-inset-bottom))', 'paddingBottom'),
        'the inset did not win over the design padding, so on a notched device these call sites ' +
          'would keep their 12px and sit under the home indicator.'
      ).toBe('34px');
    });
  });
});
