import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';
import {
  APPS_FULL_BLEED_PAGES,
  APPS_NARROW_TABLE_PAGE_WIDTH,
  APPS_PAGE_WIDTHS,
  APPS_READABLE_PAGE_WIDTH,
  APPS_REDIRECT_ONLY_PAGES,
  APPS_WIDE_PAGE_WIDTH,
} from '~/components/Apps/appsPageWidths';
import { LISTING_GRID_SPAN, LISTING_STORE_CONTAINER_SIZE } from '~/components/Apps/appListingGrid';

/**
 * `/apps/*` container-width pins (blocking `unit` project).
 *
 * The product feedback was "the apps pages should use the full page width". The
 * implementation answer is a per-route decision recorded in ONE module, with the
 * store's width kept as an explicit matched pair with the grid span. Both halves
 * are pinned here so a later tweak can't quietly re-narrow a page or move the
 * container out from under the grid.
 */

describe('APPS_PAGE_WIDTHS — the decided value per route', () => {
  test('the browse/manage surfaces are all the WIDE width (1920)', () => {
    expect(APPS_WIDE_PAGE_WIDTH).toBe(1920);
    expect(APPS_PAGE_WIDTHS['/apps']).toBe(1920);
    expect(APPS_PAGE_WIDTHS['/apps/installed']).toBe(1920);
    expect(APPS_PAGE_WIDTHS['/apps/my-submissions']).toBe(1920);
    expect(APPS_PAGE_WIDTHS['/apps/review/[publishRequestId]']).toBe(1920);
    expect(APPS_PAGE_WIDTHS['/apps/revenue']).toBe(1920);
  });

  test('the /apps/review QUEUE is the narrow-table width (1400), not the wide one', () => {
    // Four short columns (Kind / App / Submitter / Submitted) + a Review button
    // cannot spend 1920: the table pads Submitter out to ~380px for a short
    // username and opens a large dead gap before the action. Literal values, not
    // derived from the module's own constant arithmetic.
    expect(APPS_NARROW_TABLE_PAGE_WIDTH).toBe(1400);
    expect(APPS_PAGE_WIDTHS['/apps/review']).toBe(1400);
    // 🔴 The DETAIL route is deliberately NOT moved with it — it renders
    // side-by-side diff panels + a live preview, which do use the width. If a
    // later pass narrows the queue further, this is the pin that stops the detail
    // page being dragged along by association.
    expect(APPS_PAGE_WIDTHS['/apps/review/[publishRequestId]']).toBe(1920);
    // …and my-submissions keeps 1920: its table has a real 1424px scroll floor.
    expect(APPS_PAGE_WIDTHS['/apps/my-submissions']).toBe(1920);
  });

  test('the form/detail surfaces are all the READABLE width (1100)', () => {
    expect(APPS_READABLE_PAGE_WIDTH).toBe(1100);
    expect(APPS_PAGE_WIDTHS['/apps/submit']).toBe(1100);
    expect(APPS_PAGE_WIDTHS['/apps/store-preview/[slug]']).toBe(1100);
    expect(APPS_PAGE_WIDTHS['/apps/[appBlockId]/edit']).toBe(1100);
    expect(APPS_PAGE_WIDTHS['/apps/[appBlockId]/revenue']).toBe(1100);
    expect(APPS_PAGE_WIDTHS['/apps/get-started']).toBe(1100);
  });

  test('the RETIRED /apps/[appBlockId] is redirect-only, not a width', () => {
    // It was listed as a rendering route with the comment "still renders for a
    // direct hit". The page's own docstring says RETIRED and its
    // `getServerSideProps` unconditionally redirects to
    // `/apps/store-preview/<slug>`, so a width there was unreachable AND made
    // this module assert a false fact about the app.
    expect(APPS_PAGE_WIDTHS).not.toHaveProperty('/apps/[appBlockId]');
    expect(APPS_REDIRECT_ONLY_PAGES).toContain('/apps/[appBlockId]');
  });

  test('every width is one of the THREE decided values — no fourth hand-picked number', () => {
    // The whole point of the module is that there are a few CLASSES of apps page,
    // not eleven bespoke widths. A new page must join a class (or the class list
    // must grow deliberately, failing here first — which is exactly what happened
    // when `/apps/review` needed the narrow-table class).
    for (const [route, width] of Object.entries(APPS_PAGE_WIDTHS)) {
      expect(
        [APPS_WIDE_PAGE_WIDTH, APPS_NARROW_TABLE_PAGE_WIDTH, APPS_READABLE_PAGE_WIDTH],
        `${route}`
      ).toContain(width);
    }
    // Pin the class list itself, as literals. Without this the check above is
    // satisfied by ANY set of constants, including a fourth one added silently.
    expect([APPS_WIDE_PAGE_WIDTH, APPS_NARROW_TABLE_PAGE_WIDTH, APPS_READABLE_PAGE_WIDTH]).toEqual([
      1920, 1400, 1100,
    ]);
  });

  test('a route is classified exactly once (no overlap between the three lists)', () => {
    const all = [
      ...Object.keys(APPS_PAGE_WIDTHS),
      ...APPS_FULL_BLEED_PAGES,
      ...APPS_REDIRECT_ONLY_PAGES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('🔴 the store width and the store grid span are a MATCHED PAIR', () => {
  test('LISTING_STORE_CONTAINER_SIZE reads through to the /apps entry (one number, not two)', () => {
    // `appListingGrid.ts` used to carry its own literal 1600. If it drifts back to
    // a literal, this fails the moment the two disagree.
    expect(LISTING_STORE_CONTAINER_SIZE).toBe(APPS_PAGE_WIDTHS['/apps']);
    expect(LISTING_STORE_CONTAINER_SIZE).toBe(1920);
  });

  test('the widened container yields the card width the xl span was tuned for', () => {
    // The pair, stated as arithmetic rather than as a code-review promise:
    //   container 1920 − 2×16 Container padding = 1888 usable
    //   xl span 3/12 → 4 columns; Grid gutter "md" (16) → 3 gutters between them
    //   → (1888 − 3×16) / 4 = 460 px per card.
    // Pinned so that moving EITHER number without re-deriving the other fails
    // here. (The judgment call — 460px covers at 1920 vs re-tuning the span to 5
    // columns — is recorded in the PR; see `appListingGrid.ts`.)
    const CONTAINER_PADDING = 32;
    const GUTTER = 16;
    const columns = 12 / LISTING_GRID_SPAN.xl;
    const usable = (LISTING_STORE_CONTAINER_SIZE as number) - CONTAINER_PADDING;
    const cardWidth = (usable - GUTTER * (columns - 1)) / columns;
    expect(columns).toBe(4);
    expect(cardWidth).toBe(460);
  });
});

/**
 * 🔴 THE ENUMERATION GUARD — the reason this file reads the filesystem.
 *
 * A constants map is only "every apps page" if something checks it against the
 * pages that actually exist. Without this, a new `/apps/*` route silently
 * inherits `AppsPageLayout`'s `xl` default (or hand-picks a width) and the
 * "full width" decision quietly stops being true — exactly the drift that
 * produced the 1600 / 1500 / 'lg' / 'xl' / 'sm' spread this module replaced.
 */
describe('every /apps page on disk is classified', () => {
  const PAGES_DIR = path.resolve(__dirname, '../../../pages/apps');

  /** Walk `src/pages/apps` and return each page's Next route pathname. */
  function appsRoutes(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, `${prefix}/${entry.name}`);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const base = entry.name.replace(/\.tsx?$/, '');
        out.push(base === 'index' ? prefix : `${prefix}/${base}`);
      }
    };
    walk(PAGES_DIR, '/apps');
    return out.sort();
  }

  test('the walker actually found the apps pages (guards a silently-empty scan)', () => {
    // A test that classifies zero routes would pass vacuously — the failure mode
    // that makes an fs-backed guard worthless. Pin a floor and a known member.
    const routes = appsRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(15);
    expect(routes).toContain('/apps');
  });

  test('no /apps route is unclassified', () => {
    const classified = new Set<string>([
      ...Object.keys(APPS_PAGE_WIDTHS),
      ...APPS_FULL_BLEED_PAGES,
      ...APPS_REDIRECT_ONLY_PAGES,
    ]);
    const unclassified = appsRoutes().filter((r) => !classified.has(r));
    expect(
      unclassified,
      `Unclassified /apps route(s). Add each to APPS_PAGE_WIDTHS (with a width), ` +
        `APPS_FULL_BLEED_PAGES (full-viewport iframe/shell) or APPS_REDIRECT_ONLY_PAGES ` +
        `(getServerSideProps always redirects/404s) in src/components/Apps/appsPageWidths.ts.`
    ).toEqual([]);
  });

  /**
   * 🔴 CONSUMPTION — the cheap half of "is this entry real?".
   *
   * The completeness walk only proves a route is LISTED. It cannot notice that a
   * listed route's width is never read, which is exactly how
   * `/apps/[appBlockId]` came to carry a `Container size=` that its own
   * always-redirecting `getServerSideProps` made unreachable.
   *
   * Two pages read their width through a NAMED ALIAS instead of indexing the map
   * directly — the store via `LISTING_STORE_CONTAINER_SIZE` (paired with the grid
   * span) and my-submissions via `MY_SUBMISSIONS_CONTAINER_SIZE` (paired with the
   * table scroll floor). Both alias constants are defined as
   * `APPS_PAGE_WIDTHS[<route>]`, so they are genuine consumers; they are listed
   * here rather than special-cased silently.
   *
   * ⚠️ WHAT THIS STILL CANNOT CATCH: a route that is listed, consumes its width,
   * and yet never renders (because something upstream always redirects). That
   * remains a judgement made by reading the page — see the module docstring.
   */
  test('every APPS_PAGE_WIDTHS entry is actually consumed by its page', () => {
    const ALIASES: Record<string, string> = {
      '/apps': 'LISTING_STORE_CONTAINER_SIZE',
      '/apps/my-submissions': 'MY_SUBMISSIONS_CONTAINER_SIZE',
    };
    const unconsumed: string[] = [];
    for (const route of Object.keys(APPS_PAGE_WIDTHS)) {
      const rel = route === '/apps' ? '/apps/index' : route;
      const file = path.resolve(PAGES_DIR, '..', `${rel.replace(/^\/apps\//, 'apps/')}.tsx`);
      if (!fs.existsSync(file)) {
        unconsumed.push(`${route} (no page file at ${file})`);
        continue;
      }
      const src = fs.readFileSync(file, 'utf8');
      const token = ALIASES[route] ?? `APPS_PAGE_WIDTHS['${route}']`;
      if (!src.includes(token)) unconsumed.push(`${route} (expected ${token})`);
    }
    expect(
      unconsumed,
      'Listed route(s) whose page never reads the width — either wire the page up ' +
        'or move the route to APPS_FULL_BLEED_PAGES / APPS_REDIRECT_ONLY_PAGES.'
    ).toEqual([]);
  });

  test('no classified route is stale (every entry maps to a real page file)', () => {
    const onDisk = new Set(appsRoutes());
    const stale = [
      ...Object.keys(APPS_PAGE_WIDTHS),
      ...APPS_FULL_BLEED_PAGES,
      ...APPS_REDIRECT_ONLY_PAGES,
    ].filter((r) => !onDisk.has(r));
    expect(stale, 'Classified route(s) with no page file — delete the entry.').toEqual([]);
  });
});
