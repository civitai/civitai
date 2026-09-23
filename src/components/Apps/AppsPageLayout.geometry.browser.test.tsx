/**
 * `/apps` chrome — RENDERED VERTICAL GEOMETRY.
 *
 * 🔴 READ THIS BEFORE TRUSTING IT AS A GATE: it is not one. This file is in the
 * Vitest browser-mode `component` project, which CI runs only as the preview
 * pipeline's `preview / component-tests` — REPORT-ONLY and non-blocking. So nothing
 * here can block a regression. The enforceable half lives as source guards in the
 * blocking `unit` project (`__tests__/appsPageLayout.test.ts`,
 * `__tests__/appsRailGeometry.test.ts`); this file exists because those pin token names
 * and only a real render can pin PIXELS — and the layout's own comments record that token
 * math already overstated a visual difference once (a Title's line box eats part of the
 * nominal gap).
 *
 * 🔴 REWRITTEN FOR THE LEFT RAIL, AND MOST OF WHAT IT USED TO MEASURE NO LONGER EXISTS.
 * Every number in the retired table below was a property of the TAB ROW — its height, its
 * block and inline padding, the `Tabs.List::before` hairline, the tab-bottom-to-title gap.
 * There is no tab row. Rather than re-baseline those to whatever the rail happens to
 * render (which would be deriving the expectation from the implementation), they are
 * DELETED and replaced by the claims a rail actually has to hold. Recorded so the
 * deletions read as decisions:
 *
 *   retired                       why
 *   tab row height (29)           no tab row
 *   tab padBlock [6,6]            no tab; a rail entry's padding is a Tailwind class
 *   tab padInline [16,16]         same — and the `padding`-shorthand trap it guarded
 *                                 against was specific to Mantine's `Tabs` styles API
 *   marketplaceTabWidth 133.27    a measurement of one label in a horizontal strip
 *   listRule width/colour         the rail draws NO rule (pinned as an ABSENCE in
 *                                 `__tests__/appsPageLayout.test.ts`)
 *   tabsRuleToTitle (16)          the two things measured are in different columns now
 *
 * What SURVIVES unchanged is the band→body 32px gap, the container's padding, and the
 * claim that `/apps/*` starts flush under the global header — plus two claims the rail
 * adds: the two columns start at the same y, and the rail is `sticky` at the subnav gap.
 *
 * 🔴 WHY THIS FILE LOADS `@mantine/core/styles.css` AND THE OTHERS MUST NOT.
 * The shared component scaffold deliberately omits Mantine's stylesheet, so the
 * sibling browser tests assert only inline styles / ARIA. But every number this file is
 * about — `Stack`'s `gap` (a stylesheet rule consuming `--stack-gap`), the Container's
 * padding — comes FROM that stylesheet. Without the import each of them computes to 0
 * and every assertion below passes while measuring nothing. Vitest browser mode runs each
 * test file in its own iframe, so the import does not leak into the sibling suites.
 */
import '@mantine/core/styles.css';
import { describe, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';

// 🔴 The viewer MUST be one the rail renders for. `AppsPageLayout` hides the rail
// entirely below two qualifying sections, and the summary query is stubbed empty here, so
// an anonymous / non-author viewer would render NO `<nav>` at all and `measure()` would
// fail its lookup guard instead of measuring. The author capability (`appBlocksAuthor`)
// yields Marketplace + Build — two sections, which clears the floor.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
}));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'author', isModerator: false }),
}));
// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-
// module-mock) — see the sibling browser test for why.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: { blocks: { getNavSummary: { useQuery: () => ({ data: undefined }) } } },
}));

const { AppsPageLayout } = await import('./AppsPageLayout');
const { SUBNAV_STICKY_GAP } = await import('~/hooks/useSubnavBottom');

const pad = (el: Element, side: 'Top' | 'Bottom' | 'Left' | 'Right') =>
  Math.round(parseFloat(getComputedStyle(el)[`padding${side}` as 'paddingTop']) * 100) / 100;

const px2 = (n: number) => Math.round(n * 100) / 100;

type Geometry = ReturnType<typeof measure>;

/**
 * Resolve an element this file's numbers are measured FROM, or fail with the reason.
 *
 * A bare `document.querySelector(...) as HTMLElement` hands `null` on to
 * `getBoundingClientRect()` / `getComputedStyle()`, which throws an anonymous
 * `TypeError` naming neither the selector nor the likely cause. Every lookup here can
 * legitimately go missing when the rail's flag mocks stop admitting the viewer, so that
 * is the diagnosis worth printing.
 */
function required(selector: string): HTMLElement {
  const el = document.querySelector(selector) as HTMLElement | null;
  expect(
    el,
    `\`${selector}\` is not in the document. The geometry here is measured off the ` +
      '`/apps` rail, which renders only for a viewer with ≥2 qualifying sections AND at a ' +
      'viewport ≥ APPS_RAIL_MIN_VIEWPORT — check the `useFeatureFlags` / `useCurrentUser` ' +
      'mocks and the viewport above before re-baselining a number.'
  ).not.toBeNull();
  return el as HTMLElement;
}

function measure() {
  const rail = required('[data-apps-chrome="rail"]');
  const bodyColumn = required('[data-apps-chrome="body-column"]');
  const band = required('[data-apps-chrome="band"]');
  const container = required('.mantine-Container-root');
  // The sticky element is the ASIDE ITSELF (a flex item), not a wrapper inside it —
  // see the inline comment on the `<aside>`. Reading the inner div here is what the
  // retired assertions did, and it is why they reported `position: sticky` on a rail
  // that could not travel.
  const sticky = rail;
  const title = document.querySelector('h2') as HTMLElement | null;
  const body = required('[data-testid="body"]');

  const containerTop = container.getBoundingClientRect().top;
  const bandRect = band.getBoundingClientRect();
  const bodyTop = body.getBoundingClientRect().top;

  return {
    // Guard-the-guard: if the stylesheet failed to load, the Container loses its padding
    // and every gap below reads 0. Asserted in each test before anything else.
    styleSheetLoaded: pad(container, 'Left') > 0,
    containerPadInline: [pad(container, 'Left'), pad(container, 'Right')] as const,
    containerPadTop: pad(container, 'Top'),
    containerPadBottom: pad(container, 'Bottom'),
    /** The two columns' top edges, relative to the Container's content box top. */
    railTop: px2(rail.getBoundingClientRect().top - containerTop),
    bodyColumnTop: px2(bodyColumn.getBoundingClientRect().top - containerTop),
    /** The rail's sticky wrapper — position and offset, as the browser resolves them. */
    stickyPosition: getComputedStyle(sticky).position,
    stickyTop: getComputedStyle(sticky).top,
    bandToBody: px2(bodyTop - bandRect.bottom),
    topToBody: px2(bodyTop - containerTop),
    hasTitle: title != null,
  };
}

async function renderAndMeasure(ui: ReactElement): Promise<Geometry> {
  await page.viewport(1440, 900);
  renderWithProviders(ui);
  await expect.element(page.getByTestId('body')).toBeInTheDocument();
  // Two frames so layout + the injected stylesheet have both settled.
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  return measure();
}

const body = (
  <div data-testid="body" style={{ height: 200 }}>
    body
  </div>
);

/**
 * A body tall enough that the page actually scrolls. The 200px `body` above cannot
 * scroll at all, which is the second reason the retired sticky assertions could not
 * observe stickiness: even had they read the right property, there was no travel.
 */
const tallBody = (
  <div data-testid="body" style={{ height: 3000 }}>
    body
  </div>
);

/**
 * Render, measure the rail's VIEWPORT-relative top, scroll, measure again.
 *
 * Viewport is 1440 — above `APPS_RAIL_MIN_VIEWPORT` (1300), so the rail is actually
 * displayed. Measuring this below 1300 would read a `display: none` box and report a
 * pinned rail because there is no rail.
 */
async function renderTallAndScroll(ui: ReactElement) {
  await page.viewport(1440, 900);
  renderWithProviders(ui);
  await expect.element(page.getByTestId('body')).toBeInTheDocument();
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  const rail = required('[data-apps-chrome="rail"]');
  const container = required('.mantine-Container-root');
  // The sticky element is the ASIDE ITSELF (a flex item), not a wrapper inside it —
  // see the inline comment on the `<aside>`. Reading the inner div here is what the
  // retired assertions did, and it is why they reported `position: sticky` on a rail
  // that could not travel.
  const sticky = rail;
  const stickyPosition = getComputedStyle(sticky).position;
  const stickyTop = getComputedStyle(sticky).top;
  const railViewportTopBefore = px2(rail.getBoundingClientRect().top);

  const before = window.scrollY;
  window.scrollTo(0, 600);
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const scrolledBy = window.scrollY - before;
  const railViewportTopAfter = px2(rail.getBoundingClientRect().top);
  window.scrollTo(0, 0);

  return {
    styleSheetLoaded: pad(container, 'Left') > 0,
    stickyPosition,
    stickyTop,
    railViewportTopBefore,
    railViewportTopAfter,
    scrolledBy,
  };
}

describe('/apps chrome vertical geometry', () => {
  test('the Container drops its TOP pad and keeps its BOTTOM one', async () => {
    // REGRESSION coverage for the vertical-padding pass, unchanged by the rail: `/apps/*`
    // starts flush under the global header (was 16px below it), and the bottom pad stays
    // because this Container is the outermost element on every apps page — it is the only
    // thing holding the last grid/table row off whatever follows.
    const g = await renderAndMeasure(<AppsPageLayout>{body}</AppsPageLayout>);
    expect(g.styleSheetLoaded).toBe(true);
    expect(g.containerPadTop).toBe(0);
    expect(g.containerPadBottom).toBe(16);
    expect(g.containerPadInline).toEqual([16, 16]);
  });

  test('🔴 the BODY starts at the container top; the RAIL clamps to its sticky offset', async () => {
    // ⚠️ AN EARLIER REVISION ASSERTED `railTop === 0` AND CLAIMED IT WAS THE CAUSE OF THE
    // STICKY WORKING — "Both columns starting at 0 is what makes the sticky work". Both
    // halves were wrong, and together they are why a completely inert rail passed this
    // file for the whole review. `railTop === 0` held identically whether the rail pinned
    // or scrolled away; the property that decides stickiness is which box is the sticky
    // element's CONTAINING BLOCK, which no unscrolled measurement can see.
    //
    // The rail now clamps to `SUBNAV_STICKY_GAP` at rest, and that is the CORRECT value
    // rather than a regression: a sticky element whose static position is ABOVE its `top`
    // threshold is pushed down to it. This harness mounts no global subnav, so
    // `useSubnavBottom` returns 0, `top` resolves to `0 + SUBNAV_STICKY_GAP`, and the
    // Container sits flush at the viewport top — so the clamp fires immediately. On the
    // real page the same 16px is the deliberate gap between the subnav's bottom edge and
    // the rail, which is the entire reason `SUBNAV_STICKY_GAP` exists.
    //
    // The body column is NOT sticky, so it keeps starting at the container top. The pair
    // is what makes the claim readable: same container, one offset by the sticky gap.
    const g = await renderAndMeasure(<AppsPageLayout>{body}</AppsPageLayout>);
    expect(g.styleSheetLoaded).toBe(true);
    expect(g.railTop).toBe(SUBNAV_STICKY_GAP);
    expect(g.bodyColumnTop).toBe(0);
  });

  test('🔴 the rail STAYS PINNED WHEN THE PAGE SCROLLS — the whole point of the rail', async () => {
    /**
     * 🔴 THIS TEST SCROLLS, AND THAT IS THE ENTIRE REASON IT EXISTS. The two assertions
     * it replaces measured `position === 'sticky'`, `top === '16px'` and `railTop === 0`
     * WITHOUT EVER SCROLLING — and all four of those hold on an arrangement where the
     * rail is completely inert. Measured on the pre-fix markup: identical values, and a
     * rail that left the viewport at scroll 600.
     *
     * The mechanism the unscrolled assertions cannot see: `position: sticky` is
     * constrained to its CONTAINING BLOCK. The pre-fix markup put the sticky on a div
     * INSIDE `<aside class=rail>`, and `.railRow { align-items: flex-start }` shrink-wraps
     * that aside to its content height (~220px). Travel range is then
     * `aside.height − sticky.height` ≈ 0, so the rail scrolls away with the page — worse
     * than the tab strip it replaced, which at least could never be scrolled past.
     *
     * The fix follows `CollectionsLayout`, the precedent this component's docstring
     * already cites: put `position: sticky` on the FLEX ITEM itself with
     * `align-self: flex-start`. A sticky flex item's containing block is the flex
     * CONTAINER — full height — so it travels the length of the row.
     *
     * RED/GREEN MATRIX, measured in THIS harness at 1440×900 with a 3000px body. The
     * container starts flush at the viewport top here (no global subnav is mounted and
     * `containerPadTop` is 0), so the rail's natural top is 0; scrolling 600 then either
     * clamps it at the sticky offset or carries it off-screen:
     *
     *   pre-fix  : top  0 at scroll 0  →  −600 at scroll 600   (rail gone)
     *   post-fix : top 16 at scroll 0  →   +16 at scroll 600   (pinned, does not move)
     *
     * The pre-fix `0` vs post-fix `16` at rest is the sticky offset clamping — see the
     * alignment test above. The assertion that matters is the SECOND column: the pre-fix
     * rail moves by the full scroll delta, the post-fix rail does not move at all.
     */
    const g = await renderTallAndScroll(<AppsPageLayout>{tallBody}</AppsPageLayout>);
    expect(g.styleSheetLoaded).toBe(true);
    // Guard-the-guard: if the page cannot scroll, every assertion below is vacuous.
    expect(g.scrolledBy, 'the harness page did not actually scroll').toBeGreaterThan(500);
    expect(g.stickyPosition).toBe('sticky');
    expect(g.stickyTop).toBe(`${SUBNAV_STICKY_GAP}px`);
    // At rest: clamped to the sticky offset (see the alignment test for why this is 16
    // and not 0 in this harness).
    expect(g.railViewportTopBefore).toBe(SUBNAV_STICKY_GAP);
    // 🔴 THE LOAD-BEARING ASSERTION. Pinned ⇒ clamped at the sticky offset and still on
    // screen. Inert ⇒ carried up by the full scroll delta, i.e. far negative.
    expect(
      g.railViewportTopAfter,
      'the rail scrolled away with the page — `position: sticky` is inert because its ' +
        'containing block is a shrink-wrapped box with no travel range'
    ).toBe(SUBNAV_STICKY_GAP);
  });

  test('no-header page: the body starts one band-gap below the chrome', async () => {
    const g = await renderAndMeasure(<AppsPageLayout>{body}</AppsPageLayout>);
    expect(g.styleSheetLoaded).toBe(true);
    expect(g.hasTitle).toBe(false);
    // The band renders but is EMPTY on a desktop viewport: its only child on a no-header
    // page is the drawer trigger, which is `display: none` at ≥1300. So the whole chrome
    // above the body is the root stack's own `xl` gap.
    expect(g.topToBody).toBe(32);
    expect(g.bandToBody).toBe(32);
  });

  test('hasHeader page: the 32px band→body gap survives unchanged', async () => {
    const g = await renderAndMeasure(
      <AppsPageLayout
        title="Your installed apps"
        subtitle="Manage them"
        actions={<button>Act</button>}
      >
        {body}
      </AppsPageLayout>
    );
    expect(g.styleSheetLoaded).toBe(true);
    expect(g.hasTitle).toBe(true);

    // 🔴 INVARIANT GUARD — identical before and after the rail, which is the point. With
    // no rule under the header, this gap is what separates the band from the page. Its
    // partner (the 16px gap INSIDE the band) no longer has two things to sit between on a
    // desktop viewport — see the header note — so the `gap="md"` SOURCE pin in
    // `__tests__/appsPageLayout.test.ts` is what still guards that half.
    expect(g.bandToBody).toBe(32);
    // …and the header band still starts flush at the top of the page.
    expect(g.containerPadTop).toBe(0);
  });
});
