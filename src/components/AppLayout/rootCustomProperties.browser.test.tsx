/**
 * The app's `:root` custom properties must reach the component-test document.
 *
 * 🔴 THIS IS THE ONLY THING THAT PROVES THE INJECTION IN `test/component-setup.tsx`
 * ACTUALLY WORKS. Without it every `var(--x)` in a component under test resolves to
 * `""`, which makes the whole declaration invalid at computed-value time, so
 * `calc(100dvh - var(--header-height))` silently computes to `0px` and the
 * component lays out differently under test than in production. 33 TS/TSX files
 * and 7 stylesheets read `--header-height` alone, so the divergence was repo-wide
 * and nothing reported it.
 *
 * Measured, with and without the injection (real Chromium, innerHeight 896):
 *
 *   without:  --header-height = ""      calc(100dvh - var(...)) = "0px"
 *   with:     --header-height = "60px"  calc(100dvh - var(...)) = "836px"
 *
 * 🔴 IT SWEEPS EVERY INJECTED PROPERTY, NOT JUST THE ONE THIS TEST IS NAMED AFTER.
 * An earlier version asserted only `--header-height`, and an extraction bug left
 * `--footer-height` and `--buzz-color` undefined across all 190 component files
 * while it stayed green — `--footer-height` is read inside `calc()` by 8 files and
 * `--buzz-color` by 20+ SCSS modules. Checking only the property you happened to
 * think of is how a guard reads as coverage while providing almost none.
 */
import { describe, expect, test } from 'vitest';
import { INJECTED_ROOT_PROPERTIES } from '../../../test/component-setup';
import { HEADER_HEIGHT_PX } from '~/shared/constants/app-layout.constants';

const root = () => getComputedStyle(document.documentElement);

describe("the app's :root custom properties reach the component-test document", () => {
  test('every injected property resolves to a non-empty value', () => {
    // Guard the guard: an empty list would make the sweep below vacuously true,
    // which is the reassuring-zero shape.
    expect(
      INJECTED_ROOT_PROPERTIES.length,
      'the setup injected NO custom properties — the sweep below would pass vacuously'
    ).toBeGreaterThan(0);

    const unresolved = INJECTED_ROOT_PROPERTIES.filter(
      (name) => root().getPropertyValue(name).trim() === ''
    );
    expect(
      unresolved,
      'these custom properties were extracted from globals.css but do NOT resolve in the ' +
        'component-test document, so every component reading them lays out against an invalid ' +
        'declaration. Either the injected <style> is not reaching the page, or the extraction ' +
        'produced a malformed declaration that the CSS parser discarded.'
    ).toEqual([]);
  });

  test('--header-height matches HEADER_HEIGHT_PX, and a calc() that reads it computes', () => {
    const raw = root().getPropertyValue('--header-height').trim();

    // 🔴 PIN THE VALUE, not just its shape. Deriving the calc expectation below from
    // the property we just read would make a wrong VALUE undetectable — the test
    // would grade the injection against itself.
    //
    // The composition, stated precisely: `pageRunScrollContract.test.ts` (GATING
    // tier) binds CSS<->TS, and this binds INJECTED<->TS, so together they bind
    // INJECTED<->CSS. Given a green ledger this pin is close to tautological; it is
    // cheap belt-and-braces that fires if the ledger is red or skipped, not
    // independent confirmation.
    expect(
      raw,
      'the injected --header-height does not match HEADER_HEIGHT_PX — either the extraction in ' +
        'test/component-setup.tsx picked up the wrong rule, or the CSS and TS values have ' +
        'diverged (which pageRunScrollContract.test.ts would also fail on).'
    ).toBe(`${HEADER_HEIGHT_PX}px`);

    const probe = document.createElement('div');
    document.body.appendChild(probe);
    probe.style.minHeight = 'calc(100dvh - var(--header-height))';
    const computed = getComputedStyle(probe).minHeight;
    probe.remove();

    // `toBeCloseTo(..., 0)` is +/-0.5px. It cannot admit a wrong header height —
    // `raw` is pinned above — only a sub-pixel layout-viewport rounding, which is
    // real on a non-integer device-scale factor and would otherwise read as a break.
    const expected = window.innerHeight - HEADER_HEIGHT_PX;
    expect(
      parseFloat(computed),
      `a calc() reading --header-height did not compute (got "${computed}", expected about ` +
        `${expected}px) — an unresolvable var() is invalid at computed-value time and collapses ` +
        'the declaration, which shows up as 0px'
    ).toBeCloseTo(expected, 0);
  });
});
