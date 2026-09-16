/**
 * `/apps` chrome — RENDERED HORIZONTAL ALIGNMENT ACROSS ROUTES.
 *
 * 🔴 THE CHROME IS A LEFT RAIL NOW, AND THE 12-ROUTE LEDGER IS THE REASON THIS FILE
 * BARELY CHANGED. The invariant — the nav's left edge and width are IDENTICAL on every
 * `/apps/*` route — is exactly the same claim; only the numbers moved (the nav is 260px
 * wide in its own column rather than the full container width, and the body starts 276px
 * further right). Two things were ADDED rather than altered:
 *   • every alignment assertion runs ONCE PER RAIL STATE, open and collapsed, because the
 *     collapse is a new dimension the layout has and a per-route default would break the
 *     ledger by design (see `appsRailState.tsx` for why the state lives in `_app`);
 *   • the BODY's left edge is now `navLeft + railChrome` rather than `navLeft`, so the
 *     left-alignment claim moved from "the body starts where the nav starts" to "the body
 *     starts where the rail ends" — a different number, the same defect it rules out.
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
 * only this file catches is effectively unguarded. The ENFORCEABLE half therefore lives
 * in the blocking `unit` project: `__tests__/appsPageLayoutRender.test.ts` (the measure
 * box, on the rendered tree), `__tests__/appsPageLayout.test.ts` (no container-width
 * prop) and `__tests__/appsPageWidths.test.ts` (the AST adoption walk + the measures and
 * route taxonomy). This file exists because those pin STRUCTURE, and only a real browser
 * can pin PIXELS.
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
 * The container's own geometry at each viewport, as LITERALS.
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
  const containerStyle = getComputedStyle(container);
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
    styleSheetLoaded: parseFloat(containerStyle.paddingLeft) > 0,
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
        for (const { route, measure: m } of ROUTES) {
          const g = await renderAndMeasure(m, collapsed);
          expect(g.styleSheetLoaded, `${route}: Mantine stylesheet did not load`).toBe(true);
          seen[route] = [g.navLeft, g.navWidth];
          await cleanup();
        }

        // Read the loop really ran — a zero-iteration loop leaves `seen` empty and
        // every assertion below trivially true.
        expect(Object.keys(seen)).toHaveLength(ROUTES.length);

        // One assertion over the WHOLE table, so a failure names every offending
        // route and its actual pair rather than stopping at the first.
        //
        // 🔴 THE PAIR IS A LITERAL, NOT A RE-DERIVATION. `containerLeft` is the
        // Container's own left edge (which the rail does not move) and `railWidth` is
        // the state's declared width — so "every route agrees" cannot be satisfied by
        // every route measuring 0, which is exactly what an unloaded stylesheet
        // produces.
        const expected = Object.fromEntries(
          ROUTES.map(({ route }) => [route, [containerLeft, railWidth]])
        );
        expect(seen).toEqual(expected);
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
        const columnWidth = contentWidth - railChrome;
        const bodyLeft = containerLeft + railChrome;
        const seen: Record<string, [number, number]> = {};
        for (const { route, measure: m } of ROUTES) {
          const g = await renderAndMeasure(m, collapsed);
          expect(g.styleSheetLoaded, `${route}: Mantine stylesheet did not load`).toBe(true);
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

        const expected = Object.fromEntries(
          ROUTES.map(({ route, measure: m }) => [
            route,
            // LEFT-ALIGNED: the body's left edge is the same on every route, measured
            // or not — it is where the rail ends. A centred measure box would put it at
            // `bodyLeft + (columnWidth - m) / 2` and fail here, which is the whole
            // reason the box carries no auto margins.
            [bodyLeft, Math.round(resolveMeasure(m, columnWidth))],
          ])
        );
        expect(seen).toEqual(expected);

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
        expect(g.navLeft).toBe(containerLeft);
        expect(g.navWidth).toBe(railWidth);
        expect(g.bodyLeft - g.navLeft).toBe(railChrome);
        expect(g.bodyWidth).toBe(contentWidth - railChrome);
      });
    });

    test('🔴 a measured page HEADER is bounded too, and the band keeps its 32px gap to the body', async () => {
      // The audit finding this pins: with only the body bounded, a measured page's header
      // PROSE ran to the full container (/apps/submit's real subtitle measured 1224.13px
      // against a 1068 measure). Both are bounded now — and the vertical grouping must
      // survive the extra wrapper.
      //
      // ⚠️ THE 16px HALF OF THE GROUPING IS NOT ASSERTED HERE ANY MORE, AND THE DELETION
      // IS DELIBERATE RATHER THAN AN OVERSIGHT. It was `title.top − firstTab.bottom`, i.e.
      // the gap between the TAB STRIP and the title — two things that are no longer in the
      // same column, so the measurement has no subject. On a desktop viewport the band's
      // only other child (the drawer trigger) is `display: none`, so the band contains the
      // header alone and there is no in-band gap left to measure. The 32px band→body gap
      // survives unchanged and is asserted below; the `gap="md"` SOURCE pin in
      // `__tests__/appsPageLayout.test.ts` is what still guards the other number.
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

      // THE SURVIVING HALF OF THE GROUPING: 32px band→body, the number the layout's own
      // comments call load-bearing.
      const band = document.querySelector('[data-apps-chrome="band"]') as HTMLElement;
      expect(
        Math.round(
          (bodyEl.getBoundingClientRect().top - band.getBoundingClientRect().bottom) * 100
        ) / 100
      ).toBe(32);
    });
  }
);
