/**
 * `/apps` chrome — RENDERED VERTICAL GEOMETRY.
 *
 * 🔴 READ THIS BEFORE TRUSTING IT AS A GATE: it is not one. This file is in the
 * Vitest browser-mode `component` project, which CI runs only as the preview
 * pipeline's `preview / component-tests` — REPORT-ONLY, non-blocking, and red
 * repo-wide at time of writing for an unrelated pre-existing failure in
 * `AppBlockChrome.browser.test.tsx`. So nothing here can block a regression. The
 * enforceable half of this change lives as source guards in the blocking `unit`
 * project (`__tests__/appsPageLayout.test.ts`); this file exists because the
 * SOURCE guards pin token names and only a real render can pin PIXELS — and the
 * layout's own comments record that token math already overstated a visual
 * difference once (a Title's line box eats part of the nominal gap).
 *
 * 🔴 WHY THIS FILE LOADS `@mantine/core/styles.css` AND THE OTHERS MUST NOT.
 * The shared component scaffold deliberately omits Mantine's stylesheet, so the
 * sibling browser tests assert only inline styles / ARIA (see the note in
 * `AppsPageLayout.browser.test.tsx`). But every number this file is about —
 * `Stack`'s `gap` (a stylesheet rule consuming `--stack-gap`), the tab row's
 * padding, the rule under the tabs — comes FROM that stylesheet. Without the
 * import each of them computes to 0 and every assertion below passes while
 * measuring nothing. Vitest browser mode runs each test file in its own iframe,
 * so the import does not leak into the sibling suites (verified by running them
 * together and confirming their results are unchanged).
 *
 * Numbers below were measured at a 1440x900 viewport, before and after the
 * vertical-padding pass:
 *
 *                                   before    after
 *   container top -> tab row           28        0
 *   tab row height                     37       29
 *   tabs rule -> title box             16       16   <- grouping, unchanged
 *   band -> page body                  32       32   <- grouping, unchanged
 *   store index: top -> body           97       61   (-36)
 *   hasHeader:   top -> body       172.39   136.39   (-36)
 */
import '@mantine/core/styles.css';
import { describe, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-
// module-mock) — see the sibling browser test for why.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: { blocks: { getNavSummary: { useQuery: () => ({ data: undefined }) } } },
}));

const { AppsPageLayout } = await import('./AppsPageLayout');

const pad = (el: Element, side: 'Top' | 'Bottom' | 'Left' | 'Right') =>
  Math.round(parseFloat(getComputedStyle(el)[`padding${side}` as 'paddingTop']) * 100) / 100;

type Geometry = ReturnType<typeof measure>;

function measure() {
  const nav = document.querySelector('nav[aria-label="App sections"]') as HTMLElement;
  const band = nav.parentElement as HTMLElement;
  const container = band.parentElement?.parentElement as HTMLElement;
  const firstTab = document.querySelector('[role="tab"]') as HTMLElement;
  const title = document.querySelector('h2') as HTMLElement | null;
  const body = document.querySelector('[data-testid="body"]') as HTMLElement;

  const tabRect = firstTab.getBoundingClientRect();
  const containerTop = container.getBoundingClientRect().top;
  const bandRect = band.getBoundingClientRect();
  const bodyTop = body.getBoundingClientRect().top;
  const titleTop = title?.getBoundingClientRect().top ?? null;

  return {
    // Guard-the-guard: if the stylesheet failed to load, the tab collapses and
    // every gap below reads 0. Asserted in each test before anything else.
    styleSheetLoaded: pad(firstTab, 'Left') > 0,
    containerTopToTabs: Math.round((nav.getBoundingClientRect().top - containerTop) * 100) / 100,
    tabHeight: Math.round(tabRect.height * 100) / 100,
    tabPadBlock: [pad(firstTab, 'Top'), pad(firstTab, 'Bottom')] as const,
    tabPadInline: [pad(firstTab, 'Left'), pad(firstTab, 'Right')] as const,
    tabWidth: Math.round(tabRect.width * 100) / 100,
    containerPadInline: [pad(container, 'Left'), pad(container, 'Right')] as const,
    containerPadTop: pad(container, 'Top'),
    containerPadBottom: pad(container, 'Bottom'),
    // 🔴 THE REMAINING RULE LIVES ON `Tabs.List::before`, NOT ON THE TAB.
    // Probed directly, because the obvious reading is wrong in a way that makes a
    // guard vacuous: `getComputedStyle(tab).borderBottomWidth` is also `2px`, but
    // its COLOR is `rgba(0, 0, 0, 0)` — a transparent slot Mantine fills in only
    // on the ACTIVE tab. Asserting that width is >0 therefore passes with the
    // real hairline deleted. The visible rule is the list's `::before`: an
    // absolutely-positioned 2px `rgb(222, 226, 230)` bar at the list's bottom
    // edge. Colour is captured alongside width so the assertion can require the
    // rule to be VISIBLE, not merely declared.
    listRule: (() => {
      const before = getComputedStyle(nav.querySelector('[role="tablist"]') as Element, '::before');
      return {
        width: Math.round(parseFloat(before.borderBottomWidth) * 100) / 100,
        color: before.borderBottomColor,
      };
    })(),
    tabsRuleToTitle: titleTop != null ? Math.round((titleTop - tabRect.bottom) * 100) / 100 : null,
    bandToBody: Math.round((bodyTop - bandRect.bottom) * 100) / 100,
    topToBody: Math.round((bodyTop - containerTop) * 100) / 100,
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

describe('/apps chrome vertical geometry', () => {
  test('store index (no header): 61px of chrome above the body', async () => {
    const g = await renderAndMeasure(<AppsPageLayout>{body}</AppsPageLayout>);
    expect(g.styleSheetLoaded).toBe(true);

    // REGRESSION coverage — each of these was different before the pass.
    expect(g.containerPadTop).toBe(0); // was 16 (`py="md"`)
    expect(g.containerTopToTabs).toBe(0); // was 28 (16 container + 12 band `pt="sm"`)
    expect(g.tabHeight).toBe(29); // was 37
    // 0 + 29 (tabs) + 32 (band->body) = 61. Every term is an integer, so unlike
    // the `hasHeader` total this does NOT drift with font metrics.
    expect(g.topToBody).toBe(61); // was 97

    // The bottom pad is kept ON PURPOSE — this Container is the outermost element
    // on every apps page, so it is the only thing holding the last grid row off
    // whatever follows. A bare `<Container size={size}>` would zero it.
    expect(g.containerPadBottom).toBe(16);
  });

  test('hasHeader page: the grouping pair survives the pass unchanged', async () => {
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

    // 🔴 INVARIANT GUARD — these two are IDENTICAL before and after the pass, so
    // they are NOT regression coverage for it. They are the point of the test:
    // with the duplicate rule gone, this 16-vs-32 ratio is the ONLY thing
    // grouping the header band, and the pass moved everything around it. Pinning
    // them is what makes "the padding is free to move, these are not" checkable.
    expect(g.tabsRuleToTitle).toBe(16);
    expect(g.bandToBody).toBe(32);
    expect(g.bandToBody).toBe(2 * (g.tabsRuleToTitle as number));

    // The one remaining rule is still drawn AND still visible. Both halves are
    // needed: a transparent 2px border satisfies a width-only check (which is
    // exactly what the tab's own border-bottom is), so the colour is asserted to
    // be opaque rather than merely present.
    expect(g.listRule.width).toBeGreaterThan(0);
    expect(g.listRule.color).not.toMatch(/rgba\([^)]*,\s*0\)$/);

    // REGRESSION: the chrome above the title collapsed by 28px (16 + 12).
    expect(g.containerTopToTabs).toBe(0);
  });

  test('HORIZONTAL geometry is byte-identical to before the pass', async () => {
    // INVARIANT GUARD — green before and after. The brief was vertical-only, and
    // the natural failure mode of the tab edit (a `padding` shorthand instead of
    // `paddingBlock`) shows up HERE, as a narrower tab, not in any vertical
    // number. Measured 133.27px / 16px inline on both sides of the change.
    const g = await renderAndMeasure(<AppsPageLayout>{body}</AppsPageLayout>);
    expect(g.styleSheetLoaded).toBe(true);

    expect(g.tabPadInline).toEqual([16, 16]);
    expect(g.tabWidth).toBeCloseTo(133.27, 1);
    expect(g.containerPadInline).toEqual([16, 16]);
    // …while the block axis DID move.
    expect(g.tabPadBlock).toEqual([6, 6]);
  });
});
