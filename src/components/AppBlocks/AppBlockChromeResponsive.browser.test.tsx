/**
 * `AppBlockChrome` — RESPONSIVE GEOMETRY, measured in a real browser at named
 * viewports.
 *
 * 🔴 WHY THIS FILE EXISTS AT ALL. The chrome was the only breakpoint-blind
 * surface in the app: a fixed `maw={160}` on the app-name label, a fixed
 * `maw={200}` on the breadcrumb crumb and a fixed `width={200}` on the
 * platform-nav dropdown, on a bar that renders both inside a ~320px model
 * sidebar and as the header of a 2560px full-page app frame. The existing
 * suites could not see any of that: `AppBlockChrome.browser.test.tsx` sets no
 * viewport at all and `AppsPageLayout.geometry.browser.test.tsx` pins
 * `page.viewport(1440, 900)`, so a width-dependent defect passes vacuously in
 * both. Widening the harness — running the same component at a phone width AND
 * at an ultrawide width, and naming the viewport in each assertion — is part of
 * the fix, not extra work.
 *
 * 🔴 WHICH TESTS ARE REGRESSION COVERAGE AND WHICH ARE NOT. Labelled per test.
 * Two of these fail at `origin/main` against the shipped component (named in
 * each). The other three pass at `origin/main` — they are invariant guards and a
 * discriminating control, and they are deliberately NOT counted as regression
 * coverage.
 *
 * 🔴 WHY THIS FILE LOADS `@mantine/core/styles.css` AND ITS SIBLINGS MUST NOT.
 * Same reason `AppsPageLayout.geometry.browser.test.tsx` does: the shared
 * component scaffold omits Mantine's stylesheet on purpose, so the sibling
 * suites assert attributes and ARIA. But every number here — the `Group`'s flex
 * row, `ActionIcon`'s `--ai-size-sm`, the `Text`'s truncation box — comes FROM
 * that stylesheet, and without it each computes to something meaningless while
 * the assertions still pass. Vitest browser mode runs each test file in its own
 * iframe, so the import does not leak into the sibling suites.
 *
 * 🔴 THIS PROJECT IS NOT A GATE. The Vitest browser-mode `component` project is
 * report-only in CI. The gating half of this change is the node-tier
 * `__tests__/chromeGeometry.test.ts` (which is unit coverage of a new module,
 * not regression coverage — see its own header).
 */
import '@mantine/core/styles.css';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// The chrome calls `useCurrentUser()` (moderator gate on the platform-nav "Review"
// item) and there is no `CivitaiSessionProvider` here — same stub the sibling
// chrome suite uses, for the same reason.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// eslint-disable-next-line import/first
import { AppBlockChrome } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import { CHROME_BAR_PX } from '~/components/AppBlocks/slotReservation';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
// eslint-disable-next-line import/first
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The two measurement points. Named, and named again in every assertion message,
 * so a failure says WHICH width it is about. A single point could not have caught
 * this defect class in either direction.
 */
const PHONE: [number, number] = [360, 780];
const ULTRAWIDE: [number, number] = [2560, 1200];

/**
 * Width of the model-page sidebar the chrome renders in. Not a viewport — the
 * point of the third test is that the bar's OWN box, not the window, decides.
 */
const MODEL_SIDEBAR_PX = 340;

/**
 * Long enough that the label genuinely needs more than the legacy 160px cap
 * (~46 chars at Mantine `size="xs"` is ~270px), but under `sanitizeAppChromeName`'s
 * 64-char bound so the sanitizer is not the thing doing the trimming.
 */
const LONG_NAME = 'Background Remover Pro Max Ultra Deluxe Edition';

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

/**
 * Render the chrome and wait for its `ResizeObserver` to have measured itself.
 *
 * `useResizeObserver` batches its callback into a `requestAnimationFrame`, which
 * then drives a `setState`, so the resolved tier is not available on the first
 * paint. Polling on the resolved tier is bounded (1.5s) rather than open-ended so
 * that a run against code that never resolves one — `origin/main`, which has no
 * tier at all — falls through quickly to the BEHAVIOURAL assertion instead of
 * timing out on a missing attribute.
 */
async function renderChrome({
  viewport,
  wrapperWidth,
  expectTier,
  ...props
}: {
  viewport: [number, number];
  wrapperWidth?: number;
  expectTier: string;
  appName?: string;
  slotId?: string;
}) {
  await page.viewport(...viewport);
  const chrome = <AppBlockChrome blockInstanceId="inst-responsive" {...props} />;
  renderWithProviders(
    wrapperWidth != null ? <div style={{ width: wrapperWidth }}>{chrome}</div> : chrome
  );
  await expect.element(page.getByTestId('app-block-chrome')).toBeInTheDocument();
  const root = page.getByTestId('app-block-chrome').element() as HTMLElement;

  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && root.getAttribute('data-chrome-tier') !== expectTier) {
    await frame();
  }
  // Two more frames so the re-render the measurement triggered has laid out.
  await frame();
  await frame();
  return root;
}

/**
 * Guard-the-guard. Without `@mantine/core/styles.css` the `Group` is not a flex
 * row and every width below reads as something other than what ships, while the
 * assertions can still pass. Asserted first in every test.
 */
const styleSheetLoaded = (root: HTMLElement) => getComputedStyle(root).display === 'flex';

const rect = (el: Element) => el.getBoundingClientRect();

describe('AppBlockChrome responsive geometry', () => {
  test(`REGRESSION — at ${ULTRAWIDE[0]}x${ULTRAWIDE[1]} the app name is not clamped to the legacy 160px cap`, async () => {
    // 🔴 RED AT `origin/main`. The failing assertion there is the `maxWidth`
    // computed-style one below: main pins `maw={160}` unconditionally, so at a
    // 2560px-wide bar the name box computes `160px` instead of `none`, and its
    // rendered width is exactly 160 rather than the ~270px the text needs.
    const root = await renderChrome({
      viewport: ULTRAWIDE,
      expectTier: 'xl',
      appName: LONG_NAME,
    });
    expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);

    const name = page.getByTestId('app-block-name').element();
    expect(
      getComputedStyle(name).maxWidth,
      `at ${ULTRAWIDE[0]}px the app name must not carry a fixed max-width`
    ).toBe('none');
    expect(
      Math.round(rect(name).width),
      `at ${ULTRAWIDE[0]}px the app name must render wider than the legacy 160px cap`
    ).toBeGreaterThan(160);

    // The bar itself still does not overflow — an uncapped name is only safe
    // because the label truncates inside a `minWidth: 0` flex parent.
    expect(root.scrollWidth, `no horizontal overflow at ${ULTRAWIDE[0]}px`).toBeLessThanOrEqual(
      root.clientWidth + 1
    );
    expect(root.getAttribute('data-chrome-tier')).toBe('xl');
  });

  test(`REGRESSION — at ${ULTRAWIDE[0]}x${ULTRAWIDE[1]} the platform-nav dropdown is wider than its legacy fixed 200px`, async () => {
    // 🔴 RED AT `origin/main`. The failing assertion is the dropdown-width one:
    // main pins `width={200}` on the Menu, so the measured dropdown is exactly
    // 200px at every viewport and `> 200` fails.
    const root = await renderChrome({
      viewport: ULTRAWIDE,
      expectTier: 'xl',
      appName: LONG_NAME,
    });
    expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);

    await page.getByTestId('app-platform-nav-trigger').click();
    await expect.element(page.getByText('Apps home')).toBeInTheDocument();

    const dropdown = document.querySelector('.mantine-Menu-dropdown') as HTMLElement | null;
    // Positive control on the lookup: a null here would make every width
    // assertion below unreachable, which is the reassuring-zero shape.
    expect(dropdown, 'the platform-nav dropdown must be in the document once opened').not.toBeNull();
    expect(
      Math.round(rect(dropdown as HTMLElement).width),
      `at ${ULTRAWIDE[0]}px the platform-nav dropdown must be wider than the legacy 200px`
    ).toBeGreaterThan(200);
  });

  test(`CONTROL (passes at origin/main) — a ${MODEL_SIDEBAR_PX}px bar stays narrow even at a ${ULTRAWIDE[0]}px viewport`, async () => {
    // 🔴 NOT REGRESSION COVERAGE — `origin/main` passes this, because main caps at
    // 160 everywhere. It is the DISCRIMINATING CONTROL for the mechanism choice:
    // the model-slot chrome lives in a sidebar that is narrow no matter how wide
    // the window is, so the geometry must follow the BAR's own inline size. Had
    // this been built on a viewport media query — or on the page's `main`
    // ContainerProvider, which measures the whole content column — this test would
    // go red while the two REGRESSION tests above stayed green. That is exactly
    // the mutation it is here to kill.
    const root = await renderChrome({
      viewport: ULTRAWIDE,
      wrapperWidth: MODEL_SIDEBAR_PX,
      expectTier: 'base',
      appName: LONG_NAME,
    });
    expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);

    expect(
      Math.round(rect(root).width),
      `the bar must be ${MODEL_SIDEBAR_PX}px wide despite the ${ULTRAWIDE[0]}px viewport`
    ).toBe(MODEL_SIDEBAR_PX);
    const name = page.getByTestId('app-block-name').element();
    expect(
      Math.round(rect(name).width),
      `a ${MODEL_SIDEBAR_PX}px bar must keep the narrow 160px name cap`
    ).toBeLessThanOrEqual(160);
    expect(root.scrollWidth, `no horizontal overflow in a ${MODEL_SIDEBAR_PX}px bar`).toBeLessThanOrEqual(
      root.clientWidth + 1
    );
  });

  test(`at ${PHONE[0]}x${PHONE[1]} the row stays on one line, does not overflow, and keeps its controls at full size`, async () => {
    const root = await renderChrome({
      viewport: PHONE,
      expectTier: 'base',
      appName: LONG_NAME,
    });
    expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);

    expect(root.scrollWidth, `no horizontal overflow at ${PHONE[0]}px`).toBeLessThanOrEqual(
      root.clientWidth + 1
    );

    // Both icon buttons keep their resting 26px (`ActionIcon size="sm"`). The ⋯
    // trigger is the one that gained an explicit `flexShrink: 0` in this change;
    // its left-hand sibling already had one. In a `wrap="nowrap"` row a shrinkable
    // button is what gets crushed first when the name is long.
    const navTrigger = page.getByTestId('app-platform-nav-trigger').element();
    const overflowTrigger = page.getByTestId('app-block-menu-trigger').element();
    expect(
      Math.round(rect(navTrigger).width),
      `the apps-menu trigger must keep its 26px size at ${PHONE[0]}px`
    ).toBe(26);
    expect(
      Math.round(rect(overflowTrigger).width),
      `the ⋯ trigger must keep its 26px size at ${PHONE[0]}px`
    ).toBe(26);

    // One line: the two triggers share a row.
    expect(
      Math.round(rect(navTrigger).top),
      `the row must not wrap at ${PHONE[0]}px`
    ).toBe(Math.round(rect(overflowTrigger).top));
  });

  // 🔴 NOT REGRESSION COVERAGE — both cases pass at `origin/main`, and they are
  // supposed to. `CHROME_BAR_PX` is the model slot's CLS reservation, pinned in
  // `slotReservation.ts` and asserted in `__tests__/slotReservation.test.ts`. This
  // change is width-only and must not move it; this is the check that says so at a
  // rendered pixel level rather than by reading the constant back. Two cases, not
  // one loop: `cleanup()` runs per TEST, so two renders inside one test would leave
  // two chrome bars in the document and every document-scoped query would be
  // ambiguous.
  test.each([
    ['phone', PHONE, 'base'],
    ['ultrawide', ULTRAWIDE, 'xl'],
  ] as const)(
    `INVARIANT GUARD — the bar's resting height is CHROME_BAR_PX (${CHROME_BAR_PX}) at the %s viewport`,
    async (_label, viewport, expectTier) => {
      const root = await renderChrome({ viewport, expectTier, appName: LONG_NAME });
      expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);
      expect(
        Math.round(rect(root).height),
        `the chrome bar must be exactly CHROME_BAR_PX tall at ${viewport[0]}px`
      ).toBe(CHROME_BAR_PX);
    }
  );
});
