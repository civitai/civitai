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
 * 🔴 NOTHING HERE IS A GATE — AND NEITHER IS THE OTHER TIER. The Vitest
 * browser-mode `component` project runs in CI as the REPORT-ONLY
 * `preview / component-tests` status. Its node-tier counterpart for this change
 * is `__tests__/chromeGeometry.test.ts` (which is unit coverage of a new module,
 * not regression coverage — see its own header); that tier is report-only on a
 * pull request too (`continue-on-error`) and renders a real verdict on a push to
 * `main` or a `workflow_dispatch`. NEITHER TIER BLOCKS A MERGE: `main` requires
 * no status check at all in this repo, so a red run here is a signal a reviewer
 * must read, not a door that stays shut.
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

/**
 * `ActionIcon size="sm"` at rest. `@mantine/core` 7.17.8 ships
 * `--ai-size-sm: calc(1.375rem * var(--mantine-scale))`; this repo overrides
 * neither the ActionIcon sizes nor `--mantine-scale`, so 1.375rem = 22px.
 */
const RESTING_ICON_PX = 22;

/**
 * The bar's rendered resting height: 22 (ActionIcon sm) + 8 (`py={4}` ×2) + 1
 * (bottom border). See the long note on the height guard at the bottom of this
 * file for why this is NOT `CHROME_BAR_PX` and why that is a pre-existing finding
 * rather than something this change caused.
 */
const CHROME_BAR_RENDERED_PX = RESTING_ICON_PX + 8 + 1;

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
    await expect.element(page.getByRole('menuitem', { name: 'Marketplace' })).toBeInTheDocument();

    const dropdown = document.querySelector('.mantine-Menu-dropdown') as HTMLElement | null;
    // Positive control on the lookup: a null here would make every width
    // assertion below unreachable, which is the reassuring-zero shape.
    expect(
      dropdown,
      'the platform-nav dropdown must be in the document once opened'
    ).not.toBeNull();
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
    expect(
      root.scrollWidth,
      `no horizontal overflow in a ${MODEL_SIDEBAR_PX}px bar`
    ).toBeLessThanOrEqual(root.clientWidth + 1);
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

    // Both icon buttons keep their resting size. The ⋯ trigger is the one that
    // gained an explicit `flexShrink: 0` in this change; its left-hand sibling has
    // carried one all along. In a `wrap="nowrap"` row a shrinkable button is what
    // gets crushed first when the name is long, so the load-bearing claim is the
    // RELATIONAL one — the two triggers must be the same size as each other.
    const navTrigger = page.getByTestId('app-platform-nav-trigger').element();
    const overflowTrigger = page.getByTestId('app-block-menu-trigger').element();
    expect(
      Math.round(rect(navTrigger).width),
      `the apps-menu trigger must render at its resting ActionIcon size="sm" at ${PHONE[0]}px`
    ).toBe(RESTING_ICON_PX);
    expect(
      Math.round(rect(overflowTrigger).width),
      `the ⋯ trigger must not be squeezed below the apps-menu trigger at ${PHONE[0]}px`
    ).toBe(Math.round(rect(navTrigger).width));

    // One line: the two triggers share a row.
    expect(Math.round(rect(navTrigger).top), `the row must not wrap at ${PHONE[0]}px`).toBe(
      Math.round(rect(overflowTrigger).top)
    );
  });

  // 🔴 NOT REGRESSION COVERAGE — both cases pass at `origin/main`, and they are
  // supposed to. This change is WIDTH-ONLY, and the bar's resting height is the
  // model slot's CLS reservation, so this is the check that says the height did
  // not move — at a rendered pixel level, rather than by reading a constant back.
  //
  // 🔴 IT PINS THE MEASURED HEIGHT, NOT `CHROME_BAR_PX`, AND THOSE TWO DISAGREE.
  // This test was written asserting `CHROME_BAR_PX` (35) and failed at 31 — at BOTH
  // viewports, and identically before and after this change, so it is a
  // PRE-EXISTING divergence this test found rather than one it caused. The
  // derivation comment on `CHROME_BAR_PX` in `slotReservation.ts` states
  // "`--ai-size-sm` = rem(26px) = 26px"; the installed `@mantine/core` 7.17.8 ships
  // `--ai-size-sm: calc(1.375rem * var(--mantine-scale))` = 22px, and this repo
  // overrides neither the ActionIcon sizes nor `--mantine-scale`
  // (`src/providers/ThemeProvider.tsx` sets only `color`/`variant` defaults). So the
  // real resting height is 22 + 8 (`py={4}` ×2) + 1 (border) = 31, and the slot
  // over-reserves by 4px.
  //
  // Deliberately NOT fixed here. Changing `CHROME_BAR_PX` changes the model-page
  // slot's server-seeded reservation height — a behavioural change on a different
  // surface, with its own before/after to measure — and F1 is a width-only pass.
  // Left as a reported finding; `CHROME_BAR_PX` is untouched by this change.
  //
  // Two cases, not one loop: `cleanup()` runs per TEST, so two renders inside one
  // test would leave two chrome bars in the document and every document-scoped
  // query would be ambiguous.
  test.each([
    ['phone', PHONE, 'base'],
    ['ultrawide', ULTRAWIDE, 'xl'],
  ] as const)(
    `INVARIANT GUARD — the bar's resting height is unchanged (${CHROME_BAR_RENDERED_PX}px) at the %s viewport`,
    async (_label, viewport, expectTier) => {
      const root = await renderChrome({ viewport, expectTier, appName: LONG_NAME });
      expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);
      expect(
        Math.round(rect(root).height),
        `the chrome bar's resting height must not move at ${viewport[0]}px`
      ).toBe(CHROME_BAR_RENDERED_PX);
      // The constant this height is SUPPOSED to equal, restated so the divergence
      // above is visible in the file rather than only in a commit message. It is an
      // over-reservation (35 > 31), which is the safe direction for a CLS reserve.
      expect(CHROME_BAR_PX).toBeGreaterThanOrEqual(CHROME_BAR_RENDERED_PX);
    }
  );
});
