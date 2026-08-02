import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';
import {
  APPS_FULL_BLEED_PAGES,
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
    expect(APPS_PAGE_WIDTHS['/apps/review']).toBe(1920);
    expect(APPS_PAGE_WIDTHS['/apps/review/[publishRequestId]']).toBe(1920);
    expect(APPS_PAGE_WIDTHS['/apps/revenue']).toBe(1920);
  });

  test('the form/detail surfaces are all the READABLE width (1100)', () => {
    expect(APPS_READABLE_PAGE_WIDTH).toBe(1100);
    expect(APPS_PAGE_WIDTHS['/apps/submit']).toBe(1100);
    expect(APPS_PAGE_WIDTHS['/apps/store-preview/[slug]']).toBe(1100);
    expect(APPS_PAGE_WIDTHS['/apps/[appBlockId]/edit']).toBe(1100);
    expect(APPS_PAGE_WIDTHS['/apps/[appBlockId]/revenue']).toBe(1100);
    expect(APPS_PAGE_WIDTHS['/apps/[appBlockId]']).toBe(1100);
    expect(APPS_PAGE_WIDTHS['/apps/get-started']).toBe(1100);
  });

  test('every width is one of the TWO decided values — no third hand-picked number', () => {
    // The whole point of the module is that there are two classes of apps page,
    // not eleven bespoke widths. A new page must join a class (or the class list
    // must grow deliberately, failing here first).
    for (const [route, width] of Object.entries(APPS_PAGE_WIDTHS)) {
      expect([APPS_WIDE_PAGE_WIDTH, APPS_READABLE_PAGE_WIDTH], `${route}`).toContain(width);
    }
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
