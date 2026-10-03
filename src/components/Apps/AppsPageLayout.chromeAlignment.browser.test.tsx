/**
 * `/apps` chrome — RENDERED HORIZONTAL ALIGNMENT ACROSS ROUTES.
 *
 * 🔴 THE INVARIANT IS AN EQUALITY BETWEEN ROUTES, NOT A SET OF PIXEL VALUES, AND THIS
 * FILE NOW SAYS SO IN CODE. It used to build its expectation as a table of literals —
 * `[containerLeft, railWidth]` per route — which asserted the right thing by arithmetic
 * coincidence and went stale on any chrome change that moved the rail's box, including
 * changes with nothing to do with route alignment. The claim is: EVERY route's nav rect
 * matches EVERY OTHER route's, and the body's left edge is that nav's left edge plus the
 * rail's declared chrome. Both are now computed FROM THE FIRST ROUTE'S OWN MEASUREMENT,
 * which makes them viewport-independent, rail-state-independent, and unable to go stale
 * when the rail's internal geometry moves.
 *
 * 🔴 WHAT STOPS THAT BEING VACUOUS — THREE THINGS, ALL DELIBERATELY KEPT:
 *   • `styleSheetLoaded`, asserted first in every test. Without
 *     `@mantine/core/styles.css` the Container computes `max-width: none` /
 *     `padding-left: 0`, every route measures `left: 0` at an identical width, and "they
 *     all agree" PASSES while measuring nothing. It is the most valuable assertion here.
 *   • THE CONTAINER's own geometry, still pinned as LITERALS per viewport (1440 / 2560 /
 *     3440 → left + content width). Those pin the Container rather than the rail, so a
 *     relational claim about the rail is anchored to a box whose absolute position is
 *     known — in particular at the CENTRED branch (3440), which is the one a
 *     re-introduced per-page container width shows up in most loudly.
 *   • the derive-then-pin `ROUTES` set, so the loops cannot quietly shrink to one element
 *     (or to none) and agree with themselves.
 *
 * 🔴 THE RAIL STATE IS A DIMENSION, NOT A SECOND SUITE: every alignment assertion runs
 * ONCE PER RAIL STATE, open and collapsed, because a per-route collapse default would
 * break the ledger by design (see `appsRailState.tsx` for why the state lives in `_app`).
 *
 * ⚠️ THE VERTICAL CLAIM THAT USED TO LIVE HERE IS GONE, AND THE DELETION IS A
 * CONSOLIDATION RATHER THAN A LOSS. The last test in this file asserted the 32px
 * band→body gap, which `AppsPageLayout.geometry.browser.test.tsx` ALREADY asserted twice —
 * so one vertical number had three homes and a vertical change had to be re-fixed in all
 * of them. That file is the single home for the page chrome's vertical geometry now;
 * `AppsRailHeaderRow.geometry.test.tsx` owns the rail's INTERNAL vertical geometry (the
 * heading row the collapse toggle shares), which is a different subject. This file is
 * horizontal only.
 *
 * ⚠️ WHAT THE MOVE COST, SAID PLAINLY: the copy deleted from here ran once per viewport
 * (1440 / 2560 / 3440) and the surviving one renders at 1440 only. The gap is a
 * non-responsive `Stack gap="xl"`, so no reachable defect is lost — but the coverage
 * narrowed, and "a consolidation rather than a loss" would be overclaiming without this
 * sentence.
 *
 * 🔴 THE DEFECT THIS PINS. `AppsPageLayout` used to take a per-page container width
 * and render `AppsSubNav` INSIDE that Container, so the ONE element required to be
 * identical on every apps page inherited each page's own width and jumped sideways as
 * you navigated. Measured on this harness before the fix:
 *
 *                                     @1440           @2560
 *   route                     size    left  width    left  width
 *   /apps                     1920      16   1408     336   1888
 *   /apps/review              1400      36   1368     596   1368
 *   /apps/store-preview/[..]  1320      76   1288     636   1288
 *   /apps/submit              1100     186   1068     746   1068
 *
 * — a 170px left / 340px width spread at 1440, and 410px / 820px at 2560. The
 * container is now uniform and the narrowing moved into the BODY, so every row of
 * that table collapses to one pair. (That table is a record of the PRE-FIX state and
 * of the 1920 cap it was measured under; the uniform container is 2560 today, which is
 * why the @2560 numbers below no longer match this column.)
 *
 * 🔴 READ THIS BEFORE TRUSTING IT AS A GATE: it is not one. This file is in the
 * Vitest browser-mode `component` project, which CI runs only as the preview
 * pipeline's `preview / component-tests` — REPORT-ONLY, non-blocking, and RED on this
 * branch for reasons that have nothing to do with `/apps`. The failing files are outside
 * `src/components/Apps` and their subtrees are byte-identical to `origin/main` here; one
 * of them (`RemixGallery/RemixGallerySubmitModal`) fails to IMPORT, which reports as
 * "no tests" rather than as a failure.
 *
 * 🔴 NO TOTALS RECORDED ON PURPOSE. This note used to carry a census ("192 files / 2119
 * tests, ONE failing") and it was stale within a day — as was the older note in
 * `AppsPageLayout.geometry.browser.test.tsx` naming `AppBlockChrome.browser.test.tsx` as
 * the culprit, which now passes. A count checked in beside the thing it counts drifts,
 * and a stale count is worse than none because it reads as a measurement. Do not
 * re-derive the culprit from any comment: run the project and read the file list.
 *
 * A permanently-red non-blocking gate trains everyone to click through it, so anything
 * only this file catches is effectively unguarded. ⚠️ THIS PARAGRAPH USED TO CONTINUE
 * "the ENFORCEABLE half therefore lives in the blocking `unit` project", AND THAT CLAIM
 * WAS FALSE. Verified 2026-10-03 against the GitHub API: `civitai/civitai` `main` carries
 * `required_status_checks: null` — there is NO required check on this branch, so NO
 * project in this repo can block a merge, `unit` included. `.github/workflows/lint.yml`'s
 * `geometry:` job says the same thing in its own comment. "Report-only" therefore
 * describes every tier here, and a local run is the only real gate.
 *
 * The `unit`-project siblings are still where the STRUCTURAL half lives and are still
 * worth having — `__tests__/appsPageLayoutRender.test.ts` (the measure box, on the
 * rendered tree), `__tests__/appsPageLayout.test.ts` (no container-width prop) and
 * `__tests__/appsPageWidths.test.ts` (the AST adoption walk + the measures and route
 * taxonomy). They are just not enforcement. This file exists because they pin STRUCTURE
 * and only a real browser can pin PIXELS.
 *
 * (Of the browser tiers, only `geometry` is RUN by that workflow at all — report-only on
 * a PR, a real red on a push to `main`. `component`, which collects this file, matches no
 * project selector there. A new rendered-pixel claim is therefore worth more in
 * `geometry`; see `AppsRailHeaderRow.geometry.test.tsx`.)
 *
 * 🔴 WHY THIS FILE LOADS `@mantine/core/styles.css` AND MOST SIBLINGS MUST NOT.
 * The shared component scaffold deliberately omits Mantine's stylesheet, so the
 * sibling browser tests assert only inline styles / ARIA. But every number here —
 * the Container's `max-width` and `padding-inline`, the tab row's padding — comes
 * FROM that stylesheet. Without the import the Container computes `max-width: none`
 * / `padding-left: 0px`, every route measures `left: 0` with the SAME width, and
 * "the nav is identically placed everywhere" PASSES while measuring nothing. That is
 * the failure mode `styleSheetLoaded` exists to catch, asserted first in every test.
 * Vitest browser mode runs each file in its own iframe, so the import does not leak
 * into the sibling suites.
 */
import '@mantine/core/styles.css';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { AppsMeasure } from './appsPageWidths';

// 🔴 The viewer MUST be one the rail renders for. `AppsPageLayout` hides the rail
// entirely below two qualifying sections, and the summary query is stubbed empty here, so
// an anonymous / non-author viewer would render NO `<nav>` at all and the measurement
// would throw on a null lookup instead of measuring. An author (`appBlocksAuthor`)
// yields Marketplace + Build.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
}));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'author', isModerator: false }),
}));
// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-
// module-mock) — see the sibling browser tests for why.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: { blocks: { getNavSummary: { useQuery: () => ({ data: undefined }) } } },
}));

const { AppsPageLayout } = await import('./AppsPageLayout');
const { APPS_PAGE_MEASURES, APPS_FULL_MEASURE_PAGES, isAppsMeasureBand } = await import(
  './appsPageWidths'
);
const { AppsRailProvider, APPS_RAIL_WIDTH, APPS_RAIL_COLLAPSED_WIDTH, appsRailChromeWidth } =
  await import('./appsRailState');

/**
 * What a measure RESOLVES TO against a given container content width.
 *
 * A number is itself; a BAND is its `clamp()`, evaluated in JS. Both are then capped by
 * the content width, because a `max-width` cannot make a box wider than its container.
 */
function resolveMeasure(measure: AppsMeasure | undefined, contentWidth: number): number {
  if (measure === undefined) return contentWidth;
  const wanted = isAppsMeasureBand(measure)
    ? Math.min(measure.max, Math.max(measure.min, (measure.grow / 100) * contentWidth))
    : measure;
  return Math.min(wanted, contentWidth);
}

/**
 * Every route that renders the shared chrome, with the measure it passes.
 *
 * 🔴 DERIVED FROM THE MODULE, NOT RETYPED, and then the derived set is pinned as a
 * literal below. Retyping it would let a route quietly leave the map and stop being
 * measured; deriving it without pinning would let the set SHRINK to one element (or
 * empty) and the "they all agree" assertion pass vacuously. Both halves are needed.
 */
const ROUTES: { route: string; measure?: AppsMeasure }[] = [
  ...APPS_FULL_MEASURE_PAGES.map((route) => ({ route, measure: undefined })),
  ...Object.entries(APPS_PAGE_MEASURES).map(([route, measure]) => ({ route, measure })),
].sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));

/**
 * The container's own geometry at each viewport, as LITERALS. 🔴 THESE ARE THE ONLY
 * ABSOLUTE NUMBERS LEFT IN THIS FILE, AND THEY PIN THE CONTAINER RATHER THAN THE RAIL —
 * see the header. They are what makes the rail's relational claim non-vacuous.
 *
 * Container `max-width: 2560`, `padding-inline: 16`, `margin-inline: auto`. So:
 *   1440 → narrower than the cap, full-bleed: left 16, content 1440 − 32 = 1408.
 *   2560 → exactly the cap, still full-bleed: left 16, content 2560 − 32 = 2528.
 *   3440 → capped, CENTRED: left (3440 − 2560)/2 + 16 = 456, content 2528.
 *
 * 🔴 THE THIRD ROW EXISTS BECAUSE THE SECOND STOPPED BEING THE CENTRED CASE. While the
 * cap was 1920, a 2560 viewport exercised the centred branch; raising it to 2560 made
 * that row full-bleed like the first, so BOTH rows would have measured the same branch
 * and the `margin-inline: auto` half of the layout would have gone unmeasured. 3440 (a
 * common ultrawide) restores it. Do not delete the row that is currently past the cap
 * without adding another one — that is the branch a re-introduced per-page container
 * width would show up in most loudly.
 *
 * 🔴 These are the POSITIVE CONTROL. "Every route agrees" is satisfied by every route
 * measuring 0, which is exactly what an unloaded stylesheet produces. Pinning the
 * agreed-upon value means the test can only pass while the layout is really laid out.
 */
/**
 * 🔴 EVERY VIEWPORT HERE IS ≥ `APPS_RAIL_MIN_VIEWPORT` (1300), DELIBERATELY. Below that
 * the rail is `display: none` and the drawer trigger takes its place, so a narrower row
 * would measure a `<nav>` that is not laid out and every number would read 0 — the
 * measuring-nothing failure `styleSheetLoaded` exists to catch, arriving by a different
 * route. The narrow form has its own coverage in `AppsRailNav.browser.test.tsx`.
 *
 * `contentWidth` is the CONTAINER's content box (unchanged by the rail); the nav's own
 * width is the rail width, which is the same on every route and at every viewport.
 */
const VIEWPORTS = [
  { width: 1440, height: 900, containerLeft: 16, contentWidth: 1408 },
  { width: 2560, height: 1440, containerLeft: 16, contentWidth: 2528 },
  { width: 3440, height: 1440, containerLeft: 456, contentWidth: 2528 },
] as const;

/** The two rail states every alignment assertion is run in. */
const RAIL_STATES = [
  { label: 'open', collapsed: false },
  { label: 'collapsed', collapsed: true },
] as const;

const px = (n: number) => Math.round(n * 100) / 100;

function measure() {
  const nav = document.querySelector('nav[aria-label="App sections"]') as HTMLElement | null;
  const container = document.querySelector('.mantine-Container-root') as HTMLElement | null;
  const body = document.querySelector('[data-testid="body"]') as HTMLElement | null;
  if (!nav || !container || !body) {
    throw new Error(
      `chrome not rendered (nav=${!!nav} container=${!!container} body=${!!body}) — ` +
        'the mocked viewer must qualify for >=2 rail sections'
    );
  }
  const navRect = nav.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const containerStyle = getComputedStyle(container);
  const padLeft = parseFloat(containerStyle.paddingLeft);
  const padRight = parseFloat(containerStyle.paddingRight);
  return {
    // Guard-the-guard: without `@mantine/core/styles.css` the Container loses its
    // max-width and padding, every route measures `left: 0` with the SAME width, and the
    // suite goes green measuring nothing.
    //
    // ⚠️ THE WITNESS MOVED WITH THE CHROME. It used to be the first TAB's
    // `padding-left`, which came from Mantine's `Tabs` stylesheet; there are no tabs
    // any more, and a rail entry's padding is a Tailwind utility this harness does NOT
    // load — so reading it would report 0 with the stylesheet present and turn the
    // control into a permanent red. The Container's own `padding-inline` comes from the
    // SAME stylesheet and is what every number below actually depends on.
    styleSheetLoaded: padLeft > 0,
    /**
     * The Container's own CONTENT box — the pair pinned as literals in `VIEWPORTS`.
     * Measured here rather than assumed so the relational claims below can be anchored
     * to a box whose absolute position is independently asserted.
     */
    containerLeft: px(containerRect.left + padLeft),
    containerContentWidth: px(containerRect.width - padLeft - padRight),
    navLeft: px(navRect.left),
    navWidth: px(navRect.width),
    bodyLeft: px(bodyRect.left),
    bodyWidth: px(bodyRect.width),
  };
}

async function renderAndMeasure(measurePx: AppsMeasure | undefined, collapsed: boolean) {
  renderWithProviders(
    // 🔴 THE RAIL STATE IS SEEDED THROUGH THE REAL PROVIDER, not a prop. That is the only
    // way to set it — the layout takes no rail prop, deliberately, because a per-route
    // value is what this file's ledger exists to forbid.
    <AppsRailProvider value={collapsed ? 'collapsed' : 'open'}>
      <AppsPageLayout measure={measurePx}>
        <div data-testid="body" style={{ height: 200 }}>
          body
        </div>
      </AppsPageLayout>
    </AppsRailProvider>
  );
  await expect.element(page.getByTestId('body')).toBeInTheDocument();
  // Two frames so layout + the injected stylesheet have both settled.
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  return measure();
}

describe('the /apps route set that renders the shared chrome', () => {
  test('🔴 is exactly these 12 routes (fails when it GROWS or SHRINKS)', () => {
    // A ledger, not a floor. The alignment assertions below loop over this set, so a
    // set that silently shrank — or emptied — would make them pass while checking
    // nothing. Adding an apps page is meant to fail here and be added deliberately.
    // 🔴 THIRTEEN UNTIL THE `/apps/build` CONSOLIDATION, AND THE SET SHRANK BY ONE RATHER
    // THAN STAYING PUT: `/apps/get-started` and `/apps/mine` were merged into `/apps/build`
    // (both 301 there, both page files deleted), so two routes left and one arrived.
    // `/apps/submit` is still here — it kept its route and only lost its sub-nav row.
    expect(ROUTES.map((r) => r.route)).toEqual([
      '/apps',
      '/apps/[appBlockId]/edit',
      '/apps/[appBlockId]/revenue',
      // 🔴 `/apps/activity` SORTS BEFORE `/apps/build` — it is `/apps/installed`
      // repointed ('a' < 'b', where 'i' > 'b'), so the position moving is not a second
      // change to review.
      '/apps/activity',
      '/apps/build',
      '/apps/invites',
      '/apps/listing/[appListingId]/edit',
      '/apps/revenue',
      '/apps/review',
      '/apps/review/[publishRequestId]',
      '/apps/store-preview/[slug]',
      '/apps/submit',
    ]);
    // Both classes are represented, so the loops below exercise the measured AND the
    // measure-free branch of the layout rather than one of them 13 times. 6/7 since
    // `/apps/review` gave up its 1368 cap and joined the full-container list. `/apps/build`
    // joins it too — its workbench state renders the submissions table, whose 1424px scroll
    // floor the readable band's 1368 ceiling cannot clear — while `/apps/get-started`, which
    // WAS measured, left with the merge. Net: the full-container half holds at 6 (one in,
    // one out) and the measured half drops from 7 to 6.
    expect(ROUTES.filter((r) => r.measure === undefined)).toHaveLength(6);
    expect(ROUTES.filter((r) => r.measure !== undefined)).toHaveLength(6);
  });
});

describe.each(VIEWPORTS)(
  'the rail is identically placed on every /apps route @$width',
  ({ width, height, containerLeft, contentWidth }) => {
    describe.each(RAIL_STATES)('rail $label', ({ collapsed }) => {
      const railWidth = collapsed ? APPS_RAIL_COLLAPSED_WIDTH : APPS_RAIL_WIDTH;
      const railChrome = appsRailChromeWidth(collapsed);

      test('nav left AND width are the same on all 12 routes', async () => {
        await page.viewport(width, height);
        const seen: Record<string, [number, number]> = {};
        const container: Record<string, [number, number]> = {};
        for (const { route, measure: m } of ROUTES) {
          const g = await renderAndMeasure(m, collapsed);
          expect(g.styleSheetLoaded, `${route}: Mantine stylesheet did not load`).toBe(true);
          seen[route] = [g.navLeft, g.navWidth];
          container[route] = [g.containerLeft, g.containerContentWidth];
          await cleanup();
        }

        // Read the loop really ran — a zero-iteration loop leaves `seen` empty and
        // every assertion below trivially true.
        expect(Object.keys(seen)).toHaveLength(ROUTES.length);

        // 🔴 THE NON-VACUITY ANCHOR, AND THE ONLY LITERAL IN THIS TEST. The CONTAINER's
        // own content box is the same on every route by construction (that is what
        // removing the per-page `size` prop bought), and its absolute position is known
        // from the viewport. Pinning it means "every route agrees about the nav" cannot
        // be satisfied by every route measuring 0 — which is exactly what an unloaded
        // stylesheet produces — without this assertion failing first.
        expect(container).toEqual(
          Object.fromEntries(ROUTES.map(({ route }) => [route, [containerLeft, contentWidth]]))
        );

        // 🔴 THE INVARIANT ITSELF: A RELATION, NOT A TABLE OF NUMBERS. Every route's nav
        // rect equals the FIRST route's — asserted as one comparison over the whole table
        // so a failure names every offending route and its actual pair rather than
        // stopping at the first. Nothing here records what that pair should be, which is
        // the point: the claim survives any change to the rail's own geometry and fails
        // only when two routes disagree.
        const [first] = ROUTES;
        const reference = seen[first.route];
        expect(seen).toEqual(Object.fromEntries(ROUTES.map(({ route }) => [route, reference])));

        // …and the rail's width is the state's DECLARED width, read from the module
        // rather than recorded here. This is the one absolute fact about the rail worth
        // asserting, and it is a module constant, not a literal: it is what distinguishes
        // "every route agrees" from "every route agrees on the wrong number".
        expect(reference[1]).toBe(railWidth);
      });

      test('the BODY still takes its measure, left-aligned AFTER the rail', async () => {
        // 🔴 THE NON-VACUITY CONTROL FOR THE TEST ABOVE. A layout that IGNORED
        // `measure` entirely would satisfy "the nav agrees everywhere" perfectly — so
        // without this, the guard is equally happy with the feature deleted. Here the
        // measured routes must actually differ from each other, and each must land on
        // its own number.
        await page.viewport(width, height);
        // The body COLUMN is the container's content minus the rail and its gap. A
        // measure then caps the body INSIDE that column, which is why the resolution
        // below is against the column and not against the container.
        //
        // 🔴 BOTH DERIVED FROM THE RENDER, NOT RECORDED. `bodyLeft` is each route's OWN
        // measured `navLeft` plus the rail's declared chrome, so the claim is "the body
        // starts where the rail ends" rather than "the body starts at 292". The column
        // width comes from the measured container content box, which the test above pins
        // against its viewport literal.
        const seen: Record<string, [number, number]> = {};
        const expected: Record<string, [number, number]> = {};
        for (const { route, measure: m } of ROUTES) {
          const g = await renderAndMeasure(m, collapsed);
          expect(g.styleSheetLoaded, `${route}: Mantine stylesheet did not load`).toBe(true);
          const columnWidth = g.containerContentWidth - railChrome;
          expected[route] = [
            // LEFT-ALIGNED: the body's left edge is one rail-chrome right of THIS
            // route's nav. A centred measure box would put it at
            // `navLeft + railChrome + (columnWidth - m) / 2` and fail here, which is the
            // whole reason the box carries no auto margins.
            px(g.navLeft + railChrome),
            Math.round(resolveMeasure(m, columnWidth)),
          ];
          // 🔴 THE WIDTH IS ROUNDED TO A WHOLE PIXEL, THE LEFT EDGE IS NOT. A BAND
          // measure is a `clamp()` whose middle term is a PERCENTAGE of the body column,
          // so the used value is subpixel and the engine's rounding does not agree with
          // JS's to the 100th of a pixel: at 2560 the clamp computes 1238.6 and the
          // rendered rect reads 1238.59. That is an artefact of the comparison, not a
          // layout fact, and it fired on exactly the four band-measured rows. The claim
          // here is WHICH width the box resolves to; a whole pixel is the resolution that
          // claim is made at. The LEFT edge stays exact — it is integral by construction
          // and is the half that catches a centred box.
          seen[route] = [g.bodyLeft, Math.round(g.bodyWidth)];
          await cleanup();
        }
        expect(Object.keys(seen)).toHaveLength(ROUTES.length);
        expect(seen).toEqual(expected);

        // …and the left edge really is the SAME on every route, measured or not. That is
        // the route-to-route invariant; the per-route comparison above is the
        // body-starts-where-the-rail-ends one, and neither implies the other (a layout
        // whose rail moved per route would satisfy the first and fail this).
        const bodyLefts = new Set(Object.values(seen).map(([left]) => left));
        expect(bodyLefts.size, `the body starts at ${[...bodyLefts]} across routes`).toBe(1);

        // And the measured routes are genuinely DISTINCT widths, so the fixture varies
        // the dimension under test instead of feeding one value 12 times. TWO classes
        // since the narrow-table cap was deleted.
        const measuredWidths = new Set(
          ROUTES.filter((r) => r.measure !== undefined).map((r) => seen[r.route][1])
        );
        expect(measuredWidths.size).toBe(2);
      });

      test('🔴 the rail costs the body exactly its chrome width, and nothing else moves', async () => {
        // 🔴 THE CROSS-STATE CLAIM, AND THE ONE A PER-ROUTE COLLAPSE WOULD BREAK. The
        // Container's own left edge is identical in both rail states; only the body's
        // start moves, and it moves by exactly the rail's declared chrome. Asserting the
        // DIFFERENCE rather than two absolute numbers is what makes this a statement
        // about the rail rather than about the viewport.
        await page.viewport(width, height);
        const g = await renderAndMeasure(undefined, collapsed);
        expect(g.styleSheetLoaded).toBe(true);
        // The Container's own box is where the viewport literals are spent…
        expect(g.containerLeft).toBe(containerLeft);
        expect(g.containerContentWidth).toBe(contentWidth);
        // …and everything about the rail is a relation to it or a module constant.
        expect(g.navLeft).toBe(g.containerLeft);
        expect(g.navWidth).toBe(railWidth);
        expect(g.bodyLeft - g.navLeft).toBe(railChrome);
        expect(g.bodyWidth).toBe(g.containerContentWidth - railChrome);
      });
    });

    test('🔴 a measured page HEADER is bounded too, and shares the body’s left edge', async () => {
      // The audit finding this pins: with only the body bounded, a measured page's header
      // PROSE ran to the full container (/apps/submit's real subtitle measured 1224.13px
      // against a 1068 measure). Both are bounded now.
      //
      // ⚠️ THE 16px HALF OF THE BAND GROUPING WAS DELETED FROM HERE EARLIER AND THE 32px
      // HALF IS NOW GONE TOO — BOTH DELIBERATELY, AND THE SECOND IS A CONSOLIDATION. The
      // 16px gap was `title.top − firstTab.bottom`, between two things that are no longer
      // in the same column, so the measurement has no subject. The 32px band→body gap is a
      // VERTICAL claim, and `AppsPageLayout.geometry.browser.test.tsx` already asserted it
      // in TWO of its tests (`bandToBody`) — so one number had three homes and any vertical
      // change had to be re-fixed in all three. It lives there now, in the file whose
      // subject it is; the `gap="md"` / `gap="xl"` SOURCE pins in
      // `__tests__/appsPageLayout.test.ts` still guard the pair in the blocking-adjacent
      // `unit` tier. What stays here is the HORIZONTAL half, which is this file's subject.
      await page.viewport(width, height);
      renderWithProviders(
        <AppsRailProvider value="open">
          <AppsPageLayout
            measure={1068}
            title="Submit an app"
            subtitle="Choose how you want to list your app, on-platform or as an external link."
          >
            <div data-testid="body" style={{ height: 200 }}>
              body
            </div>
          </AppsPageLayout>
        </AppsRailProvider>
      );
      await expect.element(page.getByTestId('body')).toBeInTheDocument();
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

      const container = document.querySelector('.mantine-Container-root') as HTMLElement;
      expect(parseFloat(getComputedStyle(container).paddingLeft) > 0).toBe(true);

      const nav = document.querySelector('nav[aria-label="App sections"]') as HTMLElement;
      const title = document.querySelector('h2') as HTMLElement;
      const bodyEl = document.querySelector('[data-testid="body"]') as HTMLElement;
      const titleRect = title.getBoundingClientRect();

      // The header is capped at the measure, not the column…
      const headerBox = title.closest('[style*="max-width"]') as HTMLElement;
      expect(headerBox).not.toBeNull();
      expect(Math.round(headerBox.getBoundingClientRect().width)).toBe(1068);
      // …and shares its LEFT edge with the body below, one rail-chrome right of the nav.
      expect(Math.round(headerBox.getBoundingClientRect().left)).toBe(
        Math.round(bodyEl.getBoundingClientRect().left)
      );
      expect(Math.round(titleRect.left - nav.getBoundingClientRect().left)).toBe(
        appsRailChromeWidth(false)
      );
    });
  }
);
