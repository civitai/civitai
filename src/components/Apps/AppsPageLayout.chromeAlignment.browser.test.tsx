/**
 * `/apps` chrome — RENDERED HORIZONTAL ALIGNMENT ACROSS ROUTES.
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
 * that table collapses to one pair.
 *
 * 🔴 READ THIS BEFORE TRUSTING IT AS A GATE: it is not one. This file is in the
 * Vitest browser-mode `component` project, which CI runs only as the preview
 * pipeline's `preview / component-tests` — REPORT-ONLY, non-blocking, and red
 * repo-wide at time of writing for an unrelated pre-existing failure in
 * `AppBlockChrome.browser.test.tsx`. The ENFORCEABLE half lives as source guards in
 * the blocking `unit` project (`__tests__/appsPageLayout.test.ts` — no `size` prop,
 * every rendering page mounts the layout; `__tests__/appsPageWidths.test.ts` — the
 * measures and the route taxonomy). This file exists because those guards pin
 * SYMBOLS and only a real render can pin PIXELS.
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

// 🔴 The viewer MUST be one the sub-nav renders for. `AppsSubNav` hides itself
// entirely below two qualifying tabs, and the summary query is stubbed empty here, so
// an anonymous / non-author viewer would render NO `<nav>` at all and the measurement
// would throw on a null lookup instead of measuring. An author (`appBlocksAuthor`)
// yields Marketplace + Create.
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
const { APPS_PAGE_MEASURES, APPS_FULL_MEASURE_PAGES } = await import('./appsPageWidths');

/**
 * Every route that renders the shared chrome, with the measure it passes.
 *
 * 🔴 DERIVED FROM THE MODULE, NOT RETYPED, and then the derived set is pinned as a
 * literal below. Retyping it would let a route quietly leave the map and stop being
 * measured; deriving it without pinning would let the set SHRINK to one element (or
 * empty) and the "they all agree" assertion pass vacuously. Both halves are needed.
 */
const ROUTES: { route: string; measure?: number }[] = [
  ...APPS_FULL_MEASURE_PAGES.map((route) => ({ route, measure: undefined })),
  ...Object.entries(APPS_PAGE_MEASURES).map(([route, measure]) => ({ route, measure })),
].sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));

/**
 * The container's own geometry at each viewport, as LITERALS.
 *
 * Container `max-width: 1920`, `padding-inline: 16`, `margin-inline: auto`. So:
 *   1440 → narrower than the cap, full-bleed: left 16, content 1440 − 32 = 1408.
 *   2560 → capped at 1920, centred: left (2560 − 1920)/2 + 16 = 336, content 1888.
 *
 * 🔴 These are the POSITIVE CONTROL. "Every route agrees" is satisfied by every route
 * measuring 0, which is exactly what an unloaded stylesheet produces. Pinning the
 * agreed-upon value means the test can only pass while the layout is really laid out.
 */
const VIEWPORTS = [
  { width: 1440, height: 900, navLeft: 16, navWidth: 1408 },
  { width: 2560, height: 1440, navLeft: 336, navWidth: 1888 },
] as const;

const px = (n: number) => Math.round(n * 100) / 100;

function measure() {
  const nav = document.querySelector('nav[aria-label="App sections"]') as HTMLElement | null;
  const firstTab = document.querySelector('[role="tab"]') as HTMLElement | null;
  const body = document.querySelector('[data-testid="body"]') as HTMLElement | null;
  if (!nav || !firstTab || !body) {
    throw new Error(
      `chrome not rendered (nav=${!!nav} tab=${!!firstTab} body=${!!body}) — ` +
        'the mocked viewer must qualify for >=2 sub-nav tabs'
    );
  }
  const navRect = nav.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  return {
    // Guard-the-guard: without `@mantine/core/styles.css` the tab collapses, the
    // Container loses its max-width and padding, and every number below reads 0
    // IDENTICALLY on every route — i.e. the suite goes green measuring nothing.
    styleSheetLoaded: parseFloat(getComputedStyle(firstTab).paddingLeft) > 0,
    navLeft: px(navRect.left),
    navWidth: px(navRect.width),
    bodyLeft: px(bodyRect.left),
    bodyWidth: px(bodyRect.width),
  };
}

async function renderAndMeasure(measurePx: number | undefined) {
  renderWithProviders(
    <AppsPageLayout measure={measurePx}>
      <div data-testid="body" style={{ height: 200 }}>
        body
      </div>
    </AppsPageLayout>
  );
  await expect.element(page.getByTestId('body')).toBeInTheDocument();
  // Two frames so layout + the injected stylesheet have both settled.
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  return measure();
}

describe('the /apps route set that renders the shared chrome', () => {
  test('🔴 is exactly these 13 routes (fails when it GROWS or SHRINKS)', () => {
    // A ledger, not a floor. The alignment assertions below loop over this set, so a
    // set that silently shrank — or emptied — would make them pass while checking
    // nothing. Adding an apps page is meant to fail here and be added deliberately.
    expect(ROUTES.map((r) => r.route)).toEqual([
      '/apps',
      '/apps/[appBlockId]/edit',
      '/apps/[appBlockId]/revenue',
      '/apps/get-started',
      '/apps/installed',
      '/apps/invites',
      '/apps/listing/[appListingId]/edit',
      '/apps/mine',
      '/apps/revenue',
      '/apps/review',
      '/apps/review/[publishRequestId]',
      '/apps/store-preview/[slug]',
      '/apps/submit',
    ]);
    // Both classes are represented, so the loops below exercise the measured AND the
    // measure-free branch of the layout rather than one of them 13 times.
    expect(ROUTES.filter((r) => r.measure === undefined)).toHaveLength(5);
    expect(ROUTES.filter((r) => typeof r.measure === 'number')).toHaveLength(8);
  });
});

describe.each(VIEWPORTS)(
  'the sub-nav is identically placed on every /apps route @$width',
  ({ width, height, navLeft, navWidth }) => {
    test('nav left AND width are the same on all 13 routes', async () => {
      await page.viewport(width, height);
      const seen: Record<string, [number, number]> = {};
      for (const { route, measure: m } of ROUTES) {
        const g = await renderAndMeasure(m);
        expect(g.styleSheetLoaded, `${route}: Mantine stylesheet did not load`).toBe(true);
        seen[route] = [g.navLeft, g.navWidth];
        await cleanup();
      }

      // Read the loop really ran — a zero-iteration loop leaves `seen` empty and
      // every assertion below trivially true.
      expect(Object.keys(seen)).toHaveLength(ROUTES.length);

      // One assertion over the WHOLE table, so a failure names every offending
      // route and its actual pair rather than stopping at the first.
      const expected = Object.fromEntries(ROUTES.map(({ route }) => [route, [navLeft, navWidth]]));
      expect(seen).toEqual(expected);
    });

    test('the BODY still takes its measure, left-aligned under the nav', async () => {
      // 🔴 THE NON-VACUITY CONTROL FOR THE TEST ABOVE. A layout that IGNORED
      // `measure` entirely would satisfy "the nav agrees everywhere" perfectly — so
      // without this, the guard is equally happy with the feature deleted. Here the
      // measured routes must actually differ from each other, and each must land on
      // its own number.
      await page.viewport(width, height);
      const contentWidth = navWidth;
      const seen: Record<string, [number, number]> = {};
      for (const { route, measure: m } of ROUTES) {
        const g = await renderAndMeasure(m);
        expect(g.styleSheetLoaded, `${route}: Mantine stylesheet did not load`).toBe(true);
        seen[route] = [g.bodyLeft, g.bodyWidth];
        await cleanup();
      }
      expect(Object.keys(seen)).toHaveLength(ROUTES.length);

      const expected = Object.fromEntries(
        ROUTES.map(({ route, measure: m }) => [
          route,
          // LEFT-ALIGNED: the body's left edge is the nav's left edge on every
          // route, measured or not. A centred measure box would put it at
          // `navLeft + (contentWidth - m) / 2` and fail here — which is the whole
          // reason the box carries no auto margins.
          [navLeft, m === undefined ? contentWidth : Math.min(m, contentWidth)],
        ])
      );
      expect(seen).toEqual(expected);

      // And the measured routes are genuinely DISTINCT widths, so the fixture varies
      // the dimension under test instead of feeding one value 13 times.
      const measuredWidths = new Set(
        ROUTES.filter((r) => typeof r.measure === 'number').map((r) => seen[r.route][1])
      );
      expect(measuredWidths.size).toBe(3);
    });
  }
);
