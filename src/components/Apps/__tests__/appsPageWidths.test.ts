import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';
import {
  APPS_CONTAINER_GUTTER,
  APPS_FULL_BLEED_PAGES,
  APPS_FULL_MEASURE_PAGES,
  APPS_NARROW_TABLE_MEASURE,
  APPS_PAGE_CONTAINER_WIDTH,
  APPS_PAGE_MEASURES,
  APPS_READABLE_MEASURE,
  APPS_REDIRECT_ONLY_PAGES,
  APPS_TWO_COLUMN_DETAIL_MEASURE,
} from '~/components/Apps/appsPageWidths';
import * as widthsModule from '~/components/Apps/appsPageWidths';
import { LISTING_GRID_SPAN, LISTING_STORE_CONTAINER_SIZE } from '~/components/Apps/appListingGrid';
import {
  SUBMISSIONS_CONTAINER_CHROME,
  SUBMISSIONS_TABLE_MIN_WIDTH,
} from '~/components/Apps/submissionsTable';

/**
 * `/apps/*` geometry pins (blocking `unit` project).
 *
 * The model: ONE container width for every route, plus an optional CONTENT MEASURE
 * applied inside the body. It replaced a per-route CONTAINER width, which put the
 * shared sub-nav inside a per-page box and made the tab strip move horizontally
 * between routes.
 *
 * The RENDERED proof of the alignment lives in
 * `AppsPageLayout.chromeAlignment.browser.test.tsx` (browser-mode, report-only). This
 * file pins the CONSTANTS and the route taxonomy in the tier that actually gates.
 */

describe('the container is uniform, and it is the only container', () => {
  test('every `/apps/*` route renders in ONE container width (1920)', () => {
    // A literal, not derived from the module's own arithmetic.
    expect(APPS_PAGE_CONTAINER_WIDTH).toBe(1920);
  });

  test('🔴 there is no per-route CONTAINER width map any more', () => {
    // The defect was `APPS_PAGE_WIDTHS`: a container width per route. If it comes
    // back — under any name — the sub-nav starts moving again. `APPS_PAGE_MEASURES`
    // is a different thing (a BODY cap), and the layout guards in
    // `appsPageLayout.test.ts` pin that it can never reach the Container.
    // A NAMESPACE import, not `require`: the `~` alias is a Vite resolver and does
    // not exist for node's CJS loader, so `require` throws MODULE_NOT_FOUND and the
    // test fails for a reason that has nothing to do with the claim.
    expect(widthsModule).not.toHaveProperty('APPS_PAGE_WIDTHS');
    expect(widthsModule).not.toHaveProperty('APPS_WIDE_PAGE_WIDTH');
    expect(widthsModule).not.toHaveProperty('APPS_READABLE_PAGE_WIDTH');
    // Guard-the-guard: an empty namespace would satisfy every `not.toHaveProperty`.
    expect(widthsModule).toHaveProperty('APPS_PAGE_CONTAINER_WIDTH');
    expect(widthsModule).toHaveProperty('APPS_PAGE_MEASURES');
  });
});

describe('APPS_PAGE_MEASURES — the decided CONTENT measure per route', () => {
  test('the narrow-table measure is 1368 and only /apps/review takes it', () => {
    expect(APPS_NARROW_TABLE_MEASURE).toBe(1368);
    expect(APPS_PAGE_MEASURES['/apps/review']).toBe(1368);
    const takers = Object.entries(APPS_PAGE_MEASURES)
      .filter(([, m]) => m === APPS_NARROW_TABLE_MEASURE)
      .map(([r]) => r);
    expect(takers).toEqual(['/apps/review']);
  });

  test('the two-column detail measure is 1288 and only the store preview takes it', () => {
    expect(APPS_TWO_COLUMN_DETAIL_MEASURE).toBe(1288);
    expect(APPS_PAGE_MEASURES['/apps/store-preview/[slug]']).toBe(1288);
    // 🔴 Pinned in BOTH directions so a later "tidy-up" that folds the detail into
    // another class fails here rather than silently squeezing the right rail
    // (readable) or putting the markdown description on a ~1250px measure (full).
    expect(APPS_PAGE_MEASURES['/apps/store-preview/[slug]']).not.toBe(APPS_READABLE_MEASURE);
    expect(APPS_PAGE_MEASURES['/apps/store-preview/[slug]']).not.toBe(APPS_PAGE_CONTAINER_WIDTH);
  });

  test('the readable measure is 1068, and these six form/prose routes take it', () => {
    expect(APPS_READABLE_MEASURE).toBe(1068);
    const takers = Object.entries(APPS_PAGE_MEASURES)
      .filter(([, m]) => m === APPS_READABLE_MEASURE)
      .map(([r]) => r)
      .sort();
    // The SET, not a spot-check: this fails when a route joins or leaves.
    expect(takers).toEqual([
      '/apps/[appBlockId]/edit',
      '/apps/[appBlockId]/revenue',
      '/apps/get-started',
      '/apps/invites',
      '/apps/listing/[appListingId]/edit',
      '/apps/submit',
    ]);
  });

  test('every measure is one of the THREE decided values — no fourth hand-picked number', () => {
    // The whole point of the module is that there are a few CLASSES of apps page,
    // not eleven bespoke numbers. A new page must join a class, or the class list
    // must grow deliberately — failing here first.
    for (const [route, measure] of Object.entries(APPS_PAGE_MEASURES)) {
      expect(
        [APPS_NARROW_TABLE_MEASURE, APPS_TWO_COLUMN_DETAIL_MEASURE, APPS_READABLE_MEASURE],
        `${route}`
      ).toContain(measure);
    }
    // Pin the class list itself, as literals. Without this the check above is
    // satisfied by ANY set of constants, including a fourth one added silently.
    expect([
      APPS_NARROW_TABLE_MEASURE,
      APPS_TWO_COLUMN_DETAIL_MEASURE,
      APPS_READABLE_MEASURE,
    ]).toEqual([1368, 1288, 1068]);
  });

  test('🔴 a measure is always strictly inside the container', () => {
    // A measure ≥ the container is a no-op that reads as a decision. A measure
    // larger than the container's usable width is worse: it silently does nothing
    // while claiming a class.
    const usable = APPS_PAGE_CONTAINER_WIDTH - APPS_CONTAINER_GUTTER;
    for (const [route, measure] of Object.entries(APPS_PAGE_MEASURES)) {
      expect(measure, `${route} must actually narrow the body`).toBeLessThan(usable);
      expect(measure, `${route} must be a positive px value`).toBeGreaterThan(0);
    }
  });
});

describe('🔴 the measures preserve the OLD rendered content widths exactly', () => {
  /**
   * THE +32px TRAP, PINNED. Mantine's `Container` is border-box: `size={N}` renders
   * `N − 2×16` of content. A `maw={N}` box lives INSIDE that gutter and renders `N`.
   * So carrying the old round container numbers over as measures would have widened
   * every narrowed page by 32px — a confounded change hiding inside an alignment fix.
   *
   * Each measure is therefore the OLD container width minus the gutter, and the old
   * numbers are named here as literals so the provenance is checkable rather than
   * asserted in prose.
   */
  test('the Container gutter is 16px per side', () => {
    expect(APPS_CONTAINER_GUTTER).toBe(32);
  });

  test.each([
    ['narrow table', APPS_NARROW_TABLE_MEASURE, 1400],
    ['two-column detail', APPS_TWO_COLUMN_DETAIL_MEASURE, 1320],
    ['readable', APPS_READABLE_MEASURE, 1100],
  ])('%s: measure = old container width − gutter', (_label, measure, oldContainerWidth) => {
    expect(measure).toBe(oldContainerWidth - APPS_CONTAINER_GUTTER);
  });

  test('the two-column measure equals the MODEL DETAIL page content width', () => {
    // Its documented justification is "the same width as the model detail page",
    // which renders `<Container size="xl">` — Mantine's `xl` is 1320 border-box, so
    // its CONTENT is 1288. Stating the claim in content terms is what makes it true.
    const MANTINE_XL_CONTAINER = 1320;
    expect(APPS_TWO_COLUMN_DETAIL_MEASURE).toBe(MANTINE_XL_CONTAINER - APPS_CONTAINER_GUTTER);
  });
});

describe('🔴 the store width and the store grid span are a MATCHED PAIR', () => {
  test('LISTING_STORE_CONTAINER_SIZE reads the shared container width (one number, not two)', () => {
    // `appListingGrid.ts` used to carry its own literal 1600. If it drifts back to a
    // literal, this fails the moment the two disagree.
    expect(LISTING_STORE_CONTAINER_SIZE).toBe(APPS_PAGE_CONTAINER_WIDTH);
    expect(LISTING_STORE_CONTAINER_SIZE).toBe(1920);
  });

  test('🔴 /apps takes NO body measure, so its content width IS the container width', () => {
    // This is what keeps the card arithmetic below true after the container/measure
    // split. Give `/apps` a measure and the grid silently re-truncates.
    expect(APPS_PAGE_MEASURES).not.toHaveProperty('/apps');
    expect(APPS_FULL_MEASURE_PAGES).toContain('/apps');
  });

  test('the container yields the card width the xl span was tuned for', () => {
    //   container 1920 − 2×16 Container padding = 1888 usable
    //   xl span 3/12 → 4 columns; Grid gutter "md" (16) → 3 gutters between them
    //   → (1888 − 3×16) / 4 = 460 px per card.
    const GUTTER = 16;
    const columns = 12 / LISTING_GRID_SPAN.xl;
    const usable = LISTING_STORE_CONTAINER_SIZE - APPS_CONTAINER_GUTTER;
    const cardWidth = (usable - GUTTER * (columns - 1)) / columns;
    expect(columns).toBe(4);
    expect(cardWidth).toBe(460);
  });
});

describe('🔴 /apps/mine is wide enough for its table, as a RELATIONSHIP', () => {
  /**
   * This replaces the deleted `MY_APPS_CONTAINER_SIZE` alias and its `> 1100` pin.
   * The alias could not have noticed the container dropping to 1400; the relationship
   * can, because it names the floor the table actually has.
   */
  test('the container clears the submissions-table scroll floor', () => {
    const contentWidth = APPS_PAGE_CONTAINER_WIDTH - SUBMISSIONS_CONTAINER_CHROME;
    expect(contentWidth).toBeGreaterThan(SUBMISSIONS_TABLE_MIN_WIDTH);
  });

  test('…and it does so because /apps/mine takes no measure', () => {
    // If it ever took the readable measure, the floor would NOT be cleared — which
    // is exactly the clip the wide width was introduced to fix. Asserted as the
    // counterfactual so the previous test cannot pass for the wrong reason.
    expect(APPS_PAGE_MEASURES).not.toHaveProperty('/apps/mine');
    expect(APPS_FULL_MEASURE_PAGES).toContain('/apps/mine');
    expect(APPS_READABLE_MEASURE - SUBMISSIONS_CONTAINER_CHROME).toBeLessThan(
      SUBMISSIONS_TABLE_MIN_WIDTH
    );
  });
});

describe('the route taxonomy', () => {
  test('a route is classified exactly once (no overlap between the four lists)', () => {
    const all = [
      ...Object.keys(APPS_PAGE_MEASURES),
      ...APPS_FULL_MEASURE_PAGES,
      ...APPS_FULL_BLEED_PAGES,
      ...APPS_REDIRECT_ONLY_PAGES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  test('the RETIRED /apps/[appBlockId] is redirect-only, not a measure', () => {
    // It was once listed as a rendering route with the comment "still renders for a
    // direct hit". The page's own docstring says RETIRED and its
    // `getServerSideProps` unconditionally redirects, so a width there was
    // unreachable AND made the module assert a false fact about the app.
    expect(APPS_PAGE_MEASURES).not.toHaveProperty('/apps/[appBlockId]');
    expect(APPS_REDIRECT_ONLY_PAGES).toContain('/apps/[appBlockId]');
  });

  test('the merged-away /apps/my-submissions is not listed anywhere', () => {
    const all = [
      ...Object.keys(APPS_PAGE_MEASURES),
      ...APPS_FULL_MEASURE_PAGES,
      ...APPS_FULL_BLEED_PAGES,
      ...APPS_REDIRECT_ONLY_PAGES,
    ];
    expect(all).not.toContain('/apps/my-submissions');
  });
});

/**
 * 🔴 THE ENUMERATION GUARD — the reason this file reads the filesystem.
 *
 * A constants map is only "every apps page" if something checks it against the pages
 * that actually exist. Without this, a new `/apps/*` route silently renders its own
 * bare `<Container>` and the uniform-chrome decision quietly stops being true —
 * exactly the drift that left FOUR pages (`get-started`, `[appBlockId]/edit`,
 * `[appBlockId]/revenue`, `listing/[appListingId]/edit`) with no sub-nav at all.
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

  /** Absolute path of the page file backing a route pathname. */
  function pageFile(route: string): string {
    const rel = route === '/apps' ? '/apps/index' : route;
    return path.resolve(PAGES_DIR, '..', `${rel.replace(/^\/apps\//, 'apps/')}.tsx`);
  }

  test('the walker actually found the apps pages (guards a silently-empty scan)', () => {
    // A test that classifies zero routes would pass vacuously — the failure mode
    // that makes an fs-backed guard worthless. Pin a floor AND known members from
    // every list, so a walk that finds only the shallow files still fails.
    const routes = appsRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(20);
    expect(routes).toContain('/apps');
    expect(routes).toContain('/apps/review');
    expect(routes).toContain('/apps/get-started');
    expect(routes).toContain('/apps/[appBlockId]/edit');
    expect(routes).toContain('/apps/listing/[appListingId]/edit');
    expect(routes).toContain('/apps/run/[slug]/[[...path]]');
  });

  test('no /apps route is unclassified', () => {
    const classified = new Set<string>([
      ...Object.keys(APPS_PAGE_MEASURES),
      ...APPS_FULL_MEASURE_PAGES,
      ...APPS_FULL_BLEED_PAGES,
      ...APPS_REDIRECT_ONLY_PAGES,
    ]);
    const unclassified = appsRoutes().filter((r) => !classified.has(r));
    expect(
      unclassified,
      `Unclassified /apps route(s). Add each to APPS_PAGE_MEASURES (a narrower body), ` +
        `APPS_FULL_MEASURE_PAGES (full container), APPS_FULL_BLEED_PAGES (full-viewport ` +
        `iframe/shell) or APPS_REDIRECT_ONLY_PAGES (getServerSideProps always ` +
        `redirects/404s) in src/components/Apps/appsPageWidths.ts.`
    ).toEqual([]);
  });

  /**
   * 🔴 CONSUMPTION — the cheap half of "is this entry real?".
   *
   * The completeness walk only proves a route is LISTED. It cannot notice that a
   * listed route's measure is never read, which is exactly how `/apps/[appBlockId]`
   * came to carry a `Container size=` its always-redirecting `getServerSideProps`
   * made unreachable.
   *
   * There are no ALIAS consumers left. Both former ones —
   * `LISTING_STORE_CONTAINER_SIZE` for `/apps` and `MY_APPS_CONTAINER_SIZE` for
   * `/apps/mine` — existed to hand a per-page CONTAINER width to the layout; both
   * routes are now measure-free, so every entry below is read directly and the
   * special-casing is gone. (The old ALIASES map also carried real doc-rot: it named
   * `MY_SUBMISSIONS_CONTAINER_SIZE`, a constant that had been renamed.)
   *
   * ⚠️ WHAT THIS STILL CANNOT CATCH: a route that is listed, consumes its measure,
   * and yet never renders because something upstream always redirects. That remains
   * a judgement made by reading the page — see the module docstring.
   */
  test('every APPS_PAGE_MEASURES entry is actually consumed by its page', () => {
    const unconsumed: string[] = [];
    for (const route of Object.keys(APPS_PAGE_MEASURES)) {
      const file = pageFile(route);
      if (!fs.existsSync(file)) {
        unconsumed.push(`${route} (no page file at ${file})`);
        continue;
      }
      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes(`APPS_PAGE_MEASURES['${route}']`)) {
        unconsumed.push(`${route} (expected APPS_PAGE_MEASURES['${route}'])`);
      }
    }
    expect(
      unconsumed,
      'Listed route(s) whose page never reads the measure — either wire the page up ' +
        'or move the route to APPS_FULL_MEASURE_PAGES / APPS_FULL_BLEED_PAGES / ' +
        'APPS_REDIRECT_ONLY_PAGES.'
    ).toEqual([]);
  });

  /**
   * 🔴 LAYOUT ADOPTION — the guard that catches the FOUR orphans, and any new page.
   *
   * Completeness and consumption between them still allowed a page to render its own
   * bare `<Container>` with no sub-nav: `/apps/get-started`, `/apps/[appBlockId]/edit`,
   * `/apps/[appBlockId]/revenue` and `/apps/listing/[appListingId]/edit` all did, and
   * every guard in this file passed. Uniform chrome is a claim about EVERY rendering
   * route, so it is checked against every rendering route.
   */
  describe('🔴 every rendering /apps page renders the shared chrome', () => {
    /** Routes expected to mount `AppsPageLayout`: measured + full-measure. */
    const RENDERING_ROUTES = [
      ...Object.keys(APPS_PAGE_MEASURES),
      ...APPS_FULL_MEASURE_PAGES,
    ].sort();

    test('the rendering set is the one we think it is (fails if it grows OR shrinks)', () => {
      // A ledger, not a floor: a loop over a set nobody pinned passes vacuously when
      // the set empties, and silently skips a page when the set shrinks.
      expect(RENDERING_ROUTES).toEqual([
        '/apps',
        '/apps/[appBlockId]/edit',
        '/apps/[appBlockId]/revenue',
        '/apps/get-started',
        '/apps/installed',
        '/apps/invites',
        '/apps/listing/[appListingId]/edit',
        '/apps/mine',
        // 🔴 'revenue' sorts BEFORE 'review' — they diverge at index 9, 'e' < 'i'.
        '/apps/revenue',
        '/apps/review',
        '/apps/review/[publishRequestId]',
        '/apps/store-preview/[slug]',
        '/apps/submit',
      ]);
      expect(RENDERING_ROUTES).toHaveLength(13);
    });

    test('each of them imports AND mounts AppsPageLayout', () => {
      const offenders: string[] = [];
      let filesRead = 0;
      for (const route of RENDERING_ROUTES) {
        const file = pageFile(route);
        if (!fs.existsSync(file)) {
          offenders.push(`${route} (no page file at ${file})`);
          continue;
        }
        const src = fs.readFileSync(file, 'utf8');
        filesRead += 1;
        if (
          !/import\s*\{[^}]*\bAppsPageLayout\b[^}]*\}\s*from\s*'~\/components\/Apps\/AppsPageLayout'/.test(
            src
          )
        ) {
          offenders.push(`${route} (does not import AppsPageLayout)`);
          continue;
        }
        if (!/<AppsPageLayout[\s>]/.test(src)) {
          offenders.push(`${route} (imports AppsPageLayout but never renders it)`);
        }
      }
      // Guard-the-guard: a reassuring empty `offenders` is indistinguishable from a
      // loop that read nothing.
      expect(filesRead).toBe(RENDERING_ROUTES.length);
      expect(
        offenders,
        'Rendering /apps route(s) not on the shared chrome. Wrap the page body in ' +
          '<AppsPageLayout> (passing `measure` only if it is in APPS_PAGE_MEASURES) ' +
          'instead of a bare <Container>.'
      ).toEqual([]);
    });

    test('🔴 no rendering page hand-rolls its own top-level Mantine Container', () => {
      // The specific shape of the defect: a page-level `<Container>` re-creates the
      // per-page box the layout exists to remove. Nested containers inside a body
      // component are not this file's business — this checks the PAGE files, which
      // are the ones that own the outermost element.
      const offenders: string[] = [];
      let filesRead = 0;
      for (const route of RENDERING_ROUTES) {
        const file = pageFile(route);
        if (!fs.existsSync(file)) continue;
        const src = fs.readFileSync(file, 'utf8');
        filesRead += 1;
        if (/<Container[\s>]/.test(src)) offenders.push(`${route} (renders its own <Container>)`);
      }
      expect(filesRead).toBe(RENDERING_ROUTES.length);
      expect(offenders).toEqual([]);
    });
  });

  test('no classified route is stale (every entry maps to a real page file)', () => {
    const onDisk = new Set(appsRoutes());
    const stale = [
      ...Object.keys(APPS_PAGE_MEASURES),
      ...APPS_FULL_MEASURE_PAGES,
      ...APPS_FULL_BLEED_PAGES,
      ...APPS_REDIRECT_ONLY_PAGES,
    ].filter((r) => !onDisk.has(r));
    expect(stale, 'Classified route(s) with no page file — delete the entry.').toEqual([]);
  });
});
