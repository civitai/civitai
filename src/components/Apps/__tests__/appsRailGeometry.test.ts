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
  readAppsRailCookie,
} from '~/components/Apps/appsRailGeometry';
import { SUBNAV_STICKY_GAP } from '~/hooks/useSubnavBottom';

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

  test('the reserved-scrollbar allowance is the one the store ladder derives from', () => {
    expect(APPS_RESERVED_SCROLLBAR).toBe(10);
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
    // 🔴 AND NO MEDIA-QUERY HOOK, which is the thing the stylesheet exists instead of.
    // `useMediaQuery` has no server answer, so a hook-driven swap is the hydration
    // mismatch this surface has already paid for once.
    expect(layout).not.toMatch(/useMediaQuery|useIsMobile|useContainerQuery/);
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

  test('🔴 the SSR cookie reader finds the rail cookie among others, and fails open', () => {
    expect(readAppsRailCookie(undefined)).toBe('open');
    expect(readAppsRailCookie('')).toBe('open');
    expect(readAppsRailCookie('apps-rail=collapsed')).toBe('collapsed');
    // Realistic header: several cookies, arbitrary spacing, the rail one in the middle.
    expect(readAppsRailCookie('civitai-consent=accepted; apps-rail=collapsed; mode=All')).toBe(
      'collapsed'
    );
    expect(readAppsRailCookie('mode=All;apps-rail=collapsed')).toBe('collapsed');
    // A cookie whose NAME merely contains the rail's must not be read as it — the
    // substring trap a naive `includes` would walk into.
    expect(readAppsRailCookie('not-apps-rail=collapsed')).toBe('open');
    expect(readAppsRailCookie('apps-rail-other=collapsed')).toBe('open');
    // …and an absent rail cookie among present others is OPEN, not a crash.
    expect(readAppsRailCookie('mode=All; civitai-consent=accepted')).toBe('open');
  });
});
