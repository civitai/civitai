/**
 * The app's `:root` custom properties must reach the component-test document.
 *
 * 🔴 THIS IS THE ONLY THING THAT PROVES THE INJECTION IN `test/component-setup.tsx`
 * ACTUALLY WORKS. That setup throws if it cannot find the `:root` block in
 * `globals.css`, which covers the extraction — but not the half that matters:
 * whether the properties end up resolvable in the document the tests render into.
 * Without them every `var(--header-height)` in a component under test resolves to
 * `""`, which makes the whole declaration invalid at computed-value time, so
 * `calc(100dvh - var(--header-height))` silently computes to `0px` and the
 * component lays out differently under test than in production. 33 TS/TSX files
 * and 7 stylesheets read that property, so the divergence was repo-wide and
 * nothing reported it.
 *
 * Measured, with and without the injection (real Chromium, innerHeight 896):
 *
 *   without:  --header-height = ""      calc(100dvh - var(...)) = "0px"
 *   with:     --header-height = "60px"  calc(100dvh - var(...)) = "836px"
 *
 * 🔴 The expected value is derived from `window.innerHeight` at run time, not
 * hardcoded, so this cannot pass by coincidence on a differently-sized runner. The
 * `60` is read back from the custom property itself rather than restated.
 */
import { describe, expect, test } from 'vitest';
import { HEADER_HEIGHT_PX } from '~/shared/constants/app-layout.constants';

describe("the app's :root custom properties reach the component-test document", () => {
  test('--header-height is defined, and a calc() that reads it computes', () => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--header-height')
      .trim();
    expect(
      raw,
      '--header-height is undefined in the component-test document — the `:root` ' +
        'injection in test/component-setup.tsx is not reaching the page, so every component ' +
        'that reads it lays out against an invalid declaration'
    ).toMatch(/^\d+px$/);

    // 🔴 PIN THE VALUE, not just its shape. Deriving everything else from the
    // property we just read makes a wrong VALUE undetectable: if the extraction
    // captures the wrong `:root` block — a conditional one earlier in the file —
    // it injects a header height no user ever sees, and this test still passes,
    // because it grades the injection against itself. That is the
    // self-referential-assertion trap, and this line is what closes it.
    //
    // NOT circular, but state the composition precisely rather than claiming "two
    // independent paths": the ledger in
    // `src/components/AppBlocks/__tests__/pageRunScrollContract.test.ts` (GATING
    // tier) binds CSS↔TS; this binds INJECTED↔TS; together they bind INJECTED↔CSS,
    // which is the property that matters. Given a green ledger the pin below is
    // close to tautological, and its residual live coverage is `--header-height`'s
    // own value being mangled inside the block (a `;` or `}` in a value). That is
    // worth keeping, and it is less than "independent confirmation".
    expect(
      raw,
      'the injected --header-height does not match HEADER_HEIGHT_PX. Either the extraction in ' +
        'test/component-setup.tsx captured the wrong `:root` block, or the CSS and TS values ' +
        'have diverged (which pageRunScrollContract.test.ts would also fail on).'
    ).toBe(`${HEADER_HEIGHT_PX}px`);

    const probe = document.createElement('div');
    document.body.appendChild(probe);
    probe.style.minHeight = 'calc(100dvh - var(--header-height))';
    const computed = getComputedStyle(probe).minHeight;
    probe.remove();

    // Derived from the runner's viewport, never hardcoded — but compared with a
    // sub-pixel tolerance rather than as an exact string. `100dvh` resolves to the
    // layout viewport, which is fractional on a non-integer device-scale factor, so
    // an exact `===` would flake on a differently-configured runner and read as a
    // real break. The thing under test is "the var resolved and the calc computed",
    // and a 1px window says that unambiguously (the failure mode it must catch is
    // `0px`, not a rounding difference).
    // `raw` is pinned to `${HEADER_HEIGHT_PX}px` above, so say that plainly instead
    // of re-parsing it. `toBeCloseTo(…, 0)` is ±0.5px — it cannot admit a wrong
    // header height, only a sub-pixel layout-viewport rounding.
    const expected = window.innerHeight - HEADER_HEIGHT_PX;
    expect(
      parseFloat(computed),
      `a calc() reading --header-height did not compute (got "${computed}", expected about ` +
        `${expected}px) — an unresolvable var() is invalid at computed-value time and collapses ` +
        'the declaration, which shows up as 0px'
    ).toBeCloseTo(expected, 0);
  });
});
