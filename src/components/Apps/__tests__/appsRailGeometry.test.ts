import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';
import {
  APPS_RAIL_COLLAPSED_WIDTH,
  APPS_RAIL_COOKIE,
  APPS_RAIL_DEFAULT_STATE,
  APPS_RAIL_GAP,
  APPS_RAIL_MIN_VIEWPORT,
  APPS_RAIL_STORAGE_KEY,
  APPS_RESERVED_SCROLLBAR,
  appsRailChromeWidth,
  parseAppsRailState,
} from '~/components/Apps/appsRailGeometry';
import { SUBNAV_STICKY_GAP } from '~/hooks/useSubnavBottom';
import {
  LISTING_FOUR_COLUMN_MIN_WIDTH,
  listingGridColumnsAt,
} from '~/components/Apps/appListingGrid';
import { APPS_CONTAINER_GUTTER, APPS_PAGE_CONTAINER_WIDTH } from '~/components/Apps/appsPageWidths';
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

  test('🔴 the four-column store rung has ZERO margin, and this is where that is stated', () => {
    // ⚠️ `expect(APPS_RESERVED_SCROLLBAR).toBe(10)` WAS THE WHOLE TEST HERE, AND IT
    // ASSERTED A LITERAL AGAINST ITSELF — it cannot fail for the reason that matters, which
    // is what the allowance BUYS. An audit priced it: the grid at a 2560 viewport is
    // `2252 − S`, against a four-column rung of 2242, so four columns arrive **iff S ≤ 10**.
    // There is no slack at all at the one viewport the rung was derived for.
    const gridAt2560 = (scrollbar: number) =>
      APPS_PAGE_CONTAINER_WIDTH - scrollbar - APPS_CONTAINER_GUTTER - appsRailChromeWidth(false);

    expect(APPS_RESERVED_SCROLLBAR).toBe(10);
    expect(gridAt2560(APPS_RESERVED_SCROLLBAR)).toBe(LISTING_FOUR_COLUMN_MIN_WIDTH);
    // THE MARGIN, NAMED: exactly zero. Stated as a subtraction so it moves if any of the
    // four inputs moves, rather than as a number nobody re-derives.
    expect(gridAt2560(APPS_RESERVED_SCROLLBAR) - LISTING_FOUR_COLUMN_MIN_WIDTH).toBe(0);

    // …and the cliff is one pixel away, in the direction a real platform can move.
    expect(listingGridColumnsAt(gridAt2560(10)), 'S=10 — the allowance this repo assumes').toBe(4);
    expect(
      listingGridColumnsAt(gridAt2560(11)),
      'S=11 — an 11px thin gutter, 125% OS scaling or any browser zoom, and a 2560 ' +
        'monitor renders THREE 750px cards instead of four 548.5px ones'
    ).toBe(3);

    // 🔴 AND WHY THIS LIVES IN THE NODE TIER RATHER THAN THE BROWSER ONE. Measured in the
    // pinned `chrome-headless-shell`: `scrollbar-width: thin`, `auto` and `none` ALL report
    // a 0px gutter, with and without `--disable-features=OverlayScrollbar`. Every browser
    // test therefore runs at S=0, so the reserving platform — the one this rung was placed
    // for — is structurally invisible to that tier. Arithmetic is the only instrument this
    // repo has for it, so the arithmetic is asserted rather than assumed.
    expect(listingGridColumnsAt(gridAt2560(0)), 'S=0 — every browser test on this repo').toBe(4);
  });
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

  test('the layout renders BOTH classes (a stylesheet nothing references changes no pixels)', () => {
    // 🔴 LINE COMMENTS ARE STRIPPED **FIRST**, AND THE ORDER IS NOT A STYLE CHOICE.
    // `AppsPageLayout.tsx` contains the line comment "…so `/apps/*` starts directly under
    // the global header…". A block-comment-first strip — the order most of this repo's
    // source scanners use — reads that `/*` as an OPENING delimiter and deletes
    // everything up to the next `*/`, which is ~80 lines later. Measured here: it removed
    // the `classes.railRow` render entirely and this assertion failed against completely
    // correct code. A route-shaped glob in prose is ordinary in this codebase, so the
    // hazard is general rather than specific to this file.
    const stripComments = (s: string) =>
      s.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // The control for that ordering, on a fixture rather than on the file under test — a
    // control built from the artifact it is validating cannot fail independently of it.
    expect(stripComments('// a `/*` in prose\nconst keep = 1;\n')).toContain('const keep = 1;');
    expect(stripComments('/* real block */ const also = 2;')).toContain('const also = 2;');
    expect(stripComments('/* real block */ const also = 2;')).not.toContain('real block');

    const layout = stripComments(
      fs.readFileSync(path.resolve(__dirname, '../AppsPageLayout.tsx'), 'utf8')
    );
    expect(layout).toContain('AppsPageLayout.module.scss');
    expect(layout).toContain('classes.rail');
    expect(layout).toContain('classes.railDrawerTrigger');
    expect(layout).toContain('classes.railRow');
    // 🔴 AND NO MEDIA-QUERY HOOK DECIDES WHAT RENDERS, which is the thing the stylesheet
    // exists instead of. `useMediaQuery` has no server answer, so a hook-driven swap is
    // the hydration mismatch this surface has already paid for once.
    expect(layout).not.toMatch(/useMediaQuery|useIsMobile|useContainerQuery/);

    // ⚠️ THE LAYOUT DOES READ `matchMedia` — ONCE, IN AN EFFECT, AND ONLY TO CLOSE THE
    // DRAWER. That is deliberate and is NOT the banned shape: the rail/drawer swap is a
    // CSS media query, so React never learns the breakpoint was crossed and an OPEN drawer
    // survives a resize past 1300 — leaving two `App sections` landmarks and a focus trap
    // over a usable rail. An effect that can only CLOSE something cannot decide a render,
    // so it cannot reintroduce an SSR/first-paint divergence. Pinned as BOTH halves, so
    // neither the ban above nor this carve-out can be widened into the other: the call
    // must live inside a `useEffect`, and it must not appear in the returned JSX.
    expect(layout).toMatch(/useEffect\(\(\) => \{[\s\S]*?window\.matchMedia\(/);
    const jsx = layout.slice(layout.indexOf('return ('));
    expect(jsx, 'a media query reached the rendered tree').not.toMatch(/matchMedia/);
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

  test('the cookie and the localStorage key are ONE name', () => {
    // Two literals would let the SSR seed and the client store drift apart, which
    // presents as "the rail forgets, but only after a reload".
    expect(APPS_RAIL_STORAGE_KEY).toBe(APPS_RAIL_COOKIE);
    expect(APPS_RAIL_COOKIE).toBe('apps-rail');
  });

  test('🔴 the LIVE parser: a present cookie seeds, an ABSENT one stays undefined', () => {
    // 🔴 THE `undefined` HALF IS THE WHOLE TEST, AND IT IS THE BUG THIS FILE SHIPPED.
    // `appsRail` was `.catch('open').default('open')`, which can never return undefined —
    // so `_app` always handed `AppsRailProvider` a real seed, `useAppsRail`'s
    // `seed !== null` short-circuit fired on every render, and the `localStorage` fallback
    // three docstrings describe was DEAD CODE in production. Nothing caught it: the only
    // test reaching the adoption branch went through the provider-less path, which `_app`
    // never takes. It is now `.optional().catch('open')`, and this asserts the
    // discriminator survives.
    expect(parseCookies({ 'apps-rail': 'collapsed' }).appsRail).toBe('collapsed');
    expect(parseCookies({ 'apps-rail': 'open' }).appsRail).toBe('open');
    // …and the ABSENT case, which is what licenses the localStorage fallback.
    expect(parseCookies({}).appsRail).toBeUndefined();
    expect(parseCookies({ mode: 'All' }).appsRail).toBeUndefined();
  });

  test('🔴 the LIVE parser still fails OPEN on garbage, rather than to undefined', () => {
    // The other direction, and it is not the same claim: a PRESENT-but-unparseable value
    // must not be read as "no cookie", or a corrupted cookie would silently hand control
    // to `localStorage` instead of failing open. `.catch('open')` is what keeps those two
    // apart; dropping it in favour of a bare `.optional()` passes the test above and
    // breaks this one.
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
