/**
 * Unit coverage for the App Blocks chrome's responsive geometry resolver.
 *
 * 🔴 THIS FILE IS **NOT** REGRESSION COVERAGE, and saying so is the point.
 * `chromeGeometry.ts` is NEW in the same change, so every test here fails at
 * `origin/main` for the trivial reason that the module does not resolve — which
 * proves nothing about behaviour. The regression coverage for the defect this
 * change fixes (a fixed 160px name cap and a fixed 200px nav-menu width on a bar
 * that renders from 320px to 2560px wide) is the rendered-DOM suite
 * `AppBlockChromeResponsive.browser.test.tsx`, whose assertions fail at
 * `origin/main` against the SHIPPED component.
 *
 * What this file is for: the resolver is a table, and a table is exactly the
 * thing a rendered test samples rather than enumerates. These tests enumerate
 * both sides of every boundary and pin the two properties the table must have
 * (monotonic, and `base` == the pre-change constants) that no single rendered
 * viewport can express.
 *
 * It lives in the node `unit` project on purpose: that tier EXECUTES the
 * assertion, while the browser `component` project runs in CI as the REPORT-ONLY
 * `preview / component-tests` status. The node tier is report-only on a pull
 * request too (`continue-on-error`) and renders a real verdict on a push to
 * `main` or a `workflow_dispatch`. NEITHER TIER BLOCKS A MERGE: `main` requires
 * no status check at all in this repo, so this is a signal a reviewer must read,
 * not a door that stays shut.
 */
import { describe, expect, it } from 'vitest';
import {
  CHROME_BREAKPOINTS,
  resolveChromeGeometry,
  resolveChromeTier,
} from '~/components/AppBlocks/chromeGeometry';
import { breakpoints } from '~/utils/tailwind';

describe('CHROME_BREAKPOINTS', () => {
  it("is the px scale from breakpoints.json, not Mantine's stock em scale", () => {
    // Single-source drift guard. `breakpoints.json` is also what tailwind.config.js
    // require()s, so this pins the chrome to the SAME numbers the utility classes
    // use. Literals are restated here deliberately: a test that only compared the
    // module to its own import would pass with both sides wrong.
    expect(CHROME_BREAKPOINTS).toEqual({ xs: 480, sm: 768, md: 1024, lg: 1184, xl: 1440 });
    expect(CHROME_BREAKPOINTS).toEqual({
      xs: parseInt(breakpoints.xs, 10),
      sm: parseInt(breakpoints.sm, 10),
      md: parseInt(breakpoints.md, 10),
      lg: parseInt(breakpoints.lg, 10),
      xl: parseInt(breakpoints.xl, 10),
    });

    // Mantine's own (never-overridden) responsive scale is 576/768/992/1200/1408.
    // Only `sm` coincides. If a future edit swapped this module onto that scale,
    // four of these five would move — so this is the check that the two scales
    // have not been quietly blended.
    expect(CHROME_BREAKPOINTS.xs).not.toBe(576);
    expect(CHROME_BREAKPOINTS.md).not.toBe(992);
    expect(CHROME_BREAKPOINTS.lg).not.toBe(1200);
    expect(CHROME_BREAKPOINTS.xl).not.toBe(1408);
  });
});

describe('resolveChromeTier', () => {
  it('puts a 360px phone bar and a 320px model sidebar in the SAME tier', () => {
    // The whole design premise: those two are one layout problem, not two.
    expect(resolveChromeTier(360)).toBe('base');
    expect(resolveChromeTier(320)).toBe('base');
  });

  it.each([
    ['xs', CHROME_BREAKPOINTS.xs],
    ['sm', CHROME_BREAKPOINTS.sm],
    ['md', CHROME_BREAKPOINTS.md],
    ['lg', CHROME_BREAKPOINTS.lg],
    ['xl', CHROME_BREAKPOINTS.xl],
  ] as const)('applies %s AT its breakpoint and not one px below', (tier, width) => {
    // Tailwind semantics (`>=`), not Mantine's. Both sides of every boundary —
    // an off-by-one in the comparison flips exactly one of these two.
    expect(resolveChromeTier(width)).toBe(tier);
    expect(resolveChromeTier(width - 1)).not.toBe(tier);
  });

  it('treats an unmeasured / nonsensical width as the most conservative tier', () => {
    // 0 is what SSR and the first client render see, before the ResizeObserver has
    // fired. Negative / non-finite are defensive: a detached or display:none node.
    // Non-finite is included deliberately: a `ResizeObserver` never reports one, so
    // an Infinity reaching here means the caller is broken, and the safe answer is
    // the narrow tier — NOT the widest, which is what a bare `>=` ladder would give.
    for (const width of [0, -1, -1000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveChromeTier(width)).toBe('base');
    }
  });
});

describe('resolveChromeGeometry', () => {
  it('reproduces the pre-change hard-coded values at the base tier', () => {
    // 🔴 LOAD-BEARING, not a snapshot. Because `base` is what an unmeasured chrome
    // resolves to, these two numbers being the OLD ones is what makes the server
    // HTML and the first client paint byte-identical to before this change — i.e.
    // what makes this safe without an `useIsClient` hydration gate.
    expect(resolveChromeGeometry(0)).toEqual({
      tier: 'base',
      // 🔴 F3: FALSE at an unmeasured width, and this is the assertion that pins it.
      // `compact` drives a STRUCTURAL swap (breadcrumb ⇄ back chevron + centered
      // name), so resolving it `true` here would make the server render the mobile
      // shell for every viewer and then replace it one frame later on every desktop
      // page load. See the `compact` doc comment in `chromeGeometry.ts`.
      compact: false,
      nameMaxWidth: 160, // was `maw={160}` on the app-name Text
      navMenuWidth: 200, // was `width={200}` on the platform-nav Menu
    });
  });

  describe('compact — the F3 mobile-shell decision', () => {
    it('is true below sm and false at sm and above, on both sides of the boundary', () => {
      // Tailwind semantics, same as the tier table: `sm` (768) is the first
      // DESKTOP width, so 767 is compact and 768 is not. An off-by-one in the
      // comparison flips exactly one of these two and nothing else.
      expect(resolveChromeGeometry(CHROME_BREAKPOINTS.sm - 1).compact).toBe(true);
      expect(resolveChromeGeometry(CHROME_BREAKPOINTS.sm).compact).toBe(false);
      expect(resolveChromeGeometry(360).compact).toBe(true);
      expect(resolveChromeGeometry(2560).compact).toBe(false);
    });

    it('is FALSE for an unmeasured bar even though the tier is `base`', () => {
      // 🔴 THE ONE THAT WOULD BE WRONG IF `compact` WERE DERIVED FROM `tier`. Width
      // 0 — SSR, and the first client render before the ResizeObserver fires —
      // resolves to `base` because `base` carries the pre-F1 pinned widths, which
      // is what keeps the server HTML unchanged. `compact` must NOT follow it there.
      // A `tier === 'base' || tier === 'xs'` implementation passes every other test
      // in this file and fails only this one.
      expect(resolveChromeTier(0)).toBe('base');
      expect(resolveChromeGeometry(0).compact).toBe(false);
      // …and the same for the other unmeasurable inputs the resolver clamps to 0.
      for (const w of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(resolveChromeGeometry(w).compact, `width ${w} must not be compact`).toBe(false);
      }
    });

    it('is TRUE for a narrow model sidebar, which is why the SURFACE gate is the caller’s', () => {
      // A 340px desktop model sidebar is genuinely narrow, so `compact` says so.
      // The chrome still does not give it the mobile shell — it gates on
      // `isPage && compact`, because the shell replaces a breadcrumb only the
      // full-page surface has. Pinned here so a future reader does not "fix" this
      // module to answer the surface question it deliberately does not answer.
      expect(resolveChromeGeometry(340)).toMatchObject({ tier: 'base', compact: true });
    });

    it('is not a restatement of any other field — it moves where nothing else does', () => {
      // Positive control on the whole block: between 480 and 767 the tier CHANGES
      // (base→xs) while `compact` does not, and between 767 and 768 `compact`
      // changes. A field hardwired to one value satisfies none of this.
      expect(resolveChromeGeometry(479).tier).not.toBe(resolveChromeGeometry(480).tier);
      expect(resolveChromeGeometry(479).compact).toBe(resolveChromeGeometry(480).compact);
      expect(resolveChromeGeometry(767).compact).not.toBe(resolveChromeGeometry(768).compact);
    });
  });

  it('uncaps the app name only once the bar is xl-wide', () => {
    // The 2560px full-page frame is the case this exists for: a 160px cap there is
    // absurd. Below xl every tier still states a number, so the name can never eat
    // an unbounded share of a mid-width bar.
    expect(resolveChromeGeometry(2560).nameMaxWidth).toBeUndefined();
    expect(resolveChromeGeometry(CHROME_BREAKPOINTS.xl).nameMaxWidth).toBeUndefined();
    expect(resolveChromeGeometry(CHROME_BREAKPOINTS.xl - 1).nameMaxWidth).toBe(560);
    for (const w of [0, 360, 480, 768, 1024, 1184]) {
      expect(typeof resolveChromeGeometry(w).nameMaxWidth).toBe('number');
    }
  });

  it('never truncates harder as the bar gets wider', () => {
    // Monotonicity is the property a hand-edited table loses first. Sampled at
    // every boundary AND at a midpoint of every band, since a table edit can break
    // ordering between two rows without moving a boundary.
    const widths = [
      0, 240, 479, 480, 600, 767, 768, 900, 1023, 1024, 1100, 1183, 1184, 1300, 1439, 1440, 2560,
    ];
    let previousName = -1;
    let previousMenu = -1;
    for (const w of widths) {
      const g = resolveChromeGeometry(w);
      const name = g.nameMaxWidth ?? Number.POSITIVE_INFINITY;
      expect(name).toBeGreaterThanOrEqual(previousName);
      expect(g.navMenuWidth).toBeGreaterThanOrEqual(previousMenu);
      previousName = name;
      previousMenu = g.navMenuWidth;
    }
    // Positive control on the loop above: it must actually MOVE, or a table that
    // returned one constant everywhere would satisfy every comparison.
    expect(resolveChromeGeometry(2560).navMenuWidth).toBeGreaterThan(
      resolveChromeGeometry(0).navMenuWidth
    );
    expect(resolveChromeGeometry(1024).nameMaxWidth).toBeGreaterThan(
      resolveChromeGeometry(0).nameMaxWidth as number
    );
  });

  it('keeps the nav dropdown narrower than the narrowest bar it can render in', () => {
    // The dropdown is portaled to <body>, so it is bounded by the viewport rather
    // than by the bar — but the narrowest viewport we support (360px, minus the
    // page gutters) is the real floor, and the base-tier width must clear it.
    expect(resolveChromeGeometry(0).navMenuWidth).toBeLessThan(360 - 2 * 16);
  });

  it('agrees with resolveChromeTier', () => {
    for (const w of [0, 480, 768, 1024, 1184, 1440, 4000]) {
      expect(resolveChromeGeometry(w).tier).toBe(resolveChromeTier(w));
    }
  });
});
