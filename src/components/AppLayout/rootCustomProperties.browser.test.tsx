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

    const probe = document.createElement('div');
    document.body.appendChild(probe);
    probe.style.minHeight = 'calc(100dvh - var(--header-height))';
    const computed = getComputedStyle(probe).minHeight;
    probe.remove();

    // Derived, never hardcoded: the header height comes from the property we just
    // read, and the viewport from the runner.
    const expected = `${window.innerHeight - parseInt(raw, 10)}px`;
    expect(
      computed,
      'a calc() reading --header-height did not compute — an unresolvable ' +
        'var() is invalid at computed-value time and collapses the declaration'
    ).toBe(expected);
  });
});
