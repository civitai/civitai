import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';
import {
  APPS_RAIL_COLLAPSED_WIDTH,
  APPS_RAIL_COOKIE,
  APPS_RAIL_DEFAULT_STATE,
  APPS_RAIL_GAP,
  APPS_RAIL_MIN_VIEWPORT,
  appsRailChromeWidth,
  parseAppsRailState,
} from '~/components/Apps/appsRailGeometry';
import { SUBNAV_STICKY_GAP } from '~/hooks/useSubnavBottom';
// 🔴 THE PARSER PRODUCTION ACTUALLY RUNS. `_app`'s `getInitialProps` calls
// `parseCookies(getCookies(ctx))`, so this zod schema — not any helper in the rail's own
// module — is what decides the SSR seed. An earlier revision of this file tested a
// second, hand-rolled header parser that had zero production callers; see the note where
// it used to live in `appsRailGeometry.ts`.
import { parseCookies } from '~/shared/utils/cookies';

/**
 * `/apps/*` LEFT RAIL — geometry constants, the CSS seam, and the cookie parser.
 * Blocking `unit` project.
 *
 * 🔴 THE SEAM IS THE LOAD-BEARING TEST HERE, for the same reason the store grid's is:
 * `APPS_RAIL_MIN_VIEWPORT` is a TypeScript value that nothing at runtime reads. The
 * responsive switch is applied by `AppsPageLayout.module.scss`, whose `@media` thresholds
 * are hand-written CSS literals. Each half is individually correct-looking while
 * disagreeing with the other, and neither throws — the rail would simply appear at a
 * different width than every constant and comment in the codebase says it does.
 *
 * ⚠️ THE MEDIA-QUERY BAN USED TO LIVE HERE AND HAS MOVED — look for it in
 * `eslint-local-rules.js`, not in this file. It was a ~250-line hand-rolled source
 * scanner (comment-strip, string-mask, brace-match `useEffect` bodies, compare offsets)
 * that applied to exactly ONE file and was found bypassable in FIVE consecutive audit
 * rounds: an unanchored regex, brace-counting on raw text, an unterminated-apostrophe
 * mask runaway, a `/*` route-glob runaway, and a dependency-array depth bug. Every red in
 * its entire history was a planted mutant — it never caught a real violation.
 *
 * It is now `local-rules/no-ssr-divergent-media-query`, which parses with the real
 * TypeScript parser, applies wherever `.eslintrc.js` switches it on rather than to one
 * hardcoded path, and additionally covers `useContainerSmallerThan` — the hook
 * `CollectionsLayout` actually uses, which the scanner never named.
 *
 * Its headline hazard has a second, independent backstop that needs no scanner at all:
 * an UNGUARDED render-body `window.matchMedia` throws `ReferenceError: window is not
 * defined` under `renderToStaticMarkup`. Measured at the commit that removed the walk —
 * `__tests__/appsPageLayoutRender.test.ts` goes 17 passed -> 17 failed on exactly that
 * mutation.
 */

describe('the rail costs what the ladder and the layout think it costs', () => {
  test('276px open, 72px collapsed', () => {
    expect(appsRailChromeWidth(false)).toBe(276);
    expect(appsRailChromeWidth(true)).toBe(72);
    expect(APPS_RAIL_COLLAPSED_WIDTH).toBe(56);
  });

  test('🔴 the rail`s SIDE gap is the same constant as its TOP gap', () => {
    // The rail is pinned to `subnavBottom + SUBNAV_STICKY_GAP` and separated from the body
    // by `APPS_RAIL_GAP`. If those two drift the rail sits in an asymmetric corner.
    // `appsRailGeometry` deliberately does NOT import `useSubnavBottom` — that would pull
    // React into a module `appListingGrid.ts` reads — so the equality is asserted rather
    // than enforced by construction, which is what makes this test load-bearing rather
    // than tautological.
    expect(APPS_RAIL_GAP).toBe(SUBNAV_STICKY_GAP);
    expect(APPS_RAIL_GAP).toBe(16);
  });

  /**
   * ⚠️ THE ZERO-MARGIN TEST THAT LIVED HERE IS DELETED WITH THE RUNG IT PINNED.
   *
   * It asserted `LISTING_FOUR_COLUMN_MIN_WIDTH === 2242` — the four-column store rung the
   * left-rail re-tune derived from the page chrome (`2560 − 10 scrollbar − 32 gutter −
   * 276 rail`), and the fact that this left EXACTLY ZERO margin at a 2560 viewport, so
   * four columns arrived iff the scrollbar allowance held at 10px.
   *
   * That re-tune is reverted — the wide rungs come from the card-width floor again — so
   * there is no chrome-derived rung to pin and no zero-margin to defend. What survives
   * above is the rail's own COST arithmetic (276 open / 72 collapsed, and the side gap
   * equalling the top gap), which is about chrome width and is unaffected by which
   * column ladder ships.
   */
});

describe('🔴 SEAM — the stylesheet switches at exactly APPS_RAIL_MIN_VIEWPORT', () => {
  const STYLES = path.resolve(__dirname, '../AppsPageLayout.module.scss');

  /**
   * 🔴 READ LAZILY, INSIDE EACH TEST. A `readFileSync` in the describe body throws during
   * COLLECTION when the stylesheet is missing, and Vitest reports that as `Tests no
   * tests` — the reassuring-zero shape — rather than as a failure naming the missing file.
   * A deleted stylesheet is precisely the defect this seam exists to catch.
   */
  function readStyles(): string {
    if (!fs.existsSync(STYLES)) {
      throw new Error(
        `the rail's stylesheet is missing at ${STYLES} — the 1300px switch is declared in ` +
          'TypeScript and applied there, so without it the rail renders at every width.'
      );
    }
    return fs.readFileSync(STYLES, 'utf8');
  }

  /** Comments stripped FIRST: the stylesheet's own prose names 1300 verbatim. */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  /** Every `@media (min-width: Npx)` threshold, in file order. */
  const thresholds = (css: string) =>
    [...css.matchAll(/@media\s*\(\s*min-width:\s*(\d+)px\s*\)/g)].map((m) => Number(m[1]));

  test('POSITIVE CONTROL — the parser finds rules, and the comment strip did not eat them', () => {
    const source = readStyles();
    const code = strip(source);
    expect(thresholds(code).length, 'no @media rules parsed out of the stylesheet').toBeGreaterThan(
      0
    );
    // The strip really removed the prose: `276px` appears only in a docstring here and can
    // never be a media threshold, so it cannot stop being a valid witness.
    expect(source, 'the comment-strip control lost its witness').toContain('276px');
    expect(code).not.toContain('276px');
    // …and 1300 IS named in the prose, which is the thing the strip exists for: an
    // unstripped scan would find it with every real rule deleted.
    expect(source).toContain('1300');
  });

  test('🔴 every media threshold EQUALS the constant — no rule without a constant', () => {
    const found = thresholds(strip(readStyles()));
    expect(
      [...new Set(found)],
      'AppsPageLayout.module.scss and APPS_RAIL_MIN_VIEWPORT disagree. The stylesheet is ' +
        'what actually decides whether the rail renders; the constant is what every ' +
        'geometry test and docstring reasons about. Move both or neither.'
    ).toEqual([APPS_RAIL_MIN_VIEWPORT]);
  });

  test('🔴 the rail and the drawer trigger are MUTUALLY EXCLUSIVE, in both directions', () => {
    // The property that makes the hydration argument true: both shapes are always
    // RENDERED and the browser picks one, so exactly one must be displayed at any width.
    // A stylesheet that showed the rail at ≥1300 but forgot to hide the drawer trigger
    // would render two navigations side by side and no TypeScript check could see it.
    const code = strip(readStyles());
    expect(code).toMatch(/\.rail\s*\{[^}]*display:\s*none/);
    expect(code).toMatch(/\.railDrawerTrigger\s*\{[^}]*display:\s*flex/);
    const wide = code.slice(code.indexOf('@media'));
    expect(wide).toMatch(/\.rail\s*\{[^}]*display:\s*block/);
    expect(wide).toMatch(/\.railDrawerTrigger\s*\{[^}]*display:\s*none/);
  });
});

describe('the persisted state fails OPEN, always', () => {
  test('the default is open, and every unknown value resolves to it', () => {
    expect(APPS_RAIL_DEFAULT_STATE).toBe('open');
    for (const value of [undefined, null, '', 'open', 'OPEN', 'Collapsed', 'true', '1', 'x']) {
      expect(parseAppsRailState(value), `"${String(value)}"`).toBe('open');
    }
    // …and the ONE value that collapses it, so the parser is not a constant.
    expect(parseAppsRailState('collapsed')).toBe('collapsed');
  });

  test('🔴 the LIVE parser still fails OPEN on garbage, rather than to undefined', () => {
    // ⚠️ RETAINED, WITH A NEW REASON. Its original rationale was that a corrupted cookie
    // must not "hand control to `localStorage` instead of failing open" — and that store
    // is now deleted, so that sentence no longer describes anything. The BEHAVIOUR it
    // pins is still live and still load-bearing: the cookie is the sole SSR seed, so a
    // present-but-unparseable value must resolve to `'open'` rather than to `undefined`.
    // `.catch('open')` is what does that; a bare `.optional()` would leave the seed
    // undefined and the rail would still render open by default — but for an accidental
    // reason rather than a declared one, and the next schema edit would be free to break
    // it silently.
    for (const value of ['COLLAPSED', 'true', '1', 'x', '']) {
      expect(parseCookies({ 'apps-rail': value }).appsRail, `"${value}"`).toBe('open');
    }
  });

  test('the cookie NAME the live parser reads is the one the rail writes', () => {
    // The seam the deleted hand-rolled parser used to stand in for: `persistAppsRailState`
    // writes `APPS_RAIL_COOKIE`, and `parseCookiesObj` must read that same key. Two
    // literals here would be exactly the drift this asserts against.
    expect(APPS_RAIL_COOKIE).toBe('apps-rail');
    expect(parseCookies({ [APPS_RAIL_COOKIE]: 'collapsed' }).appsRail).toBe('collapsed');
    // A cookie whose name merely CONTAINS the rail's is a different cookie — the
    // substring trap a `includes`-based parser walks into.
    expect(parseCookies({ 'not-apps-rail': 'collapsed' }).appsRail).toBeUndefined();
  });
});
