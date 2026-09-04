/**
 * THE "Recently run" ROW IS ONE LINE ON THE DESKTOP DROPDOWN, MEASURED.
 *
 * 🔴 WHY A WHOLE FILE FOR ONE CLAIM. It is the claim F3's primitive is FOR. Merging
 * the chrome's two dropdowns and its bottom sheets onto one `ChromeSurface` is only
 * worth doing if the desktop rendering comes out unchanged, and this is the one place
 * it silently did not: `ChromeSurfaceItem` wraps children in
 * `<Text size="sm" lineClamp={1}>` in its SHEET branch and rendered them raw in its
 * MENU branch, so the publisher-controlled app name lost the clamp the pre-primitive
 * chrome gave it. Nothing caught it — the full node `unit` tier and all seven touched
 * browser suites were green with the defect present — because every existing test
 * either uses a short fixture name or asserts attributes rather than geometry.
 *
 * So the guard is a MEASUREMENT, not a source-text pin.
 * `__tests__/chromeItemClamp.test.ts` carries the structural half in the node `unit`
 * tier; this is the half that would still fail if `clamp` were threaded correctly and
 * rendered something that does not actually clamp.
 *
 * 🔴 THE ASSERTION IS RELATIONAL, AND NOT A PIXEL LITERAL. "The long name renders on
 * one line" is really "this row is the same height as a row that cannot wrap", so the
 * reference is a sibling item in the SAME dropdown ("Marketplace"). A `< 40px` bound
 * would be a fact about this Mantine version's line-height; the relationship is a fact
 * about the layout.
 *
 * 🔴 IT LOADS `@mantine/core/styles.css`. The shared scaffold omits it on purpose, and
 * without it `lineClamp` (which is `-webkit-line-clamp` + `display: -webkit-box`) is
 * not applied at all, so both arms measure the same wrapped height and the test passes
 * against the defect. Vitest browser mode gives each file its own iframe, so this does
 * not leak into sibling suites.
 */
import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// eslint-disable-next-line import/first
import { AppBlockChrome } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import {
  clearRecentlyOpenedApps,
  recordRecentlyOpenedApp,
} from '~/components/Apps/recentlyOpenedAppsStore';
// eslint-disable-next-line import/first
import { renderWithProviders } from '../../../test/component-setup';

/** Desktop — the ONLY path with the defect. The sheet clamps every row already. */
const DESKTOP: [number, number] = [1440, 900];

/**
 * 63 characters — one under `APP_CHROME_NAME_MAX` (64), so the SANITIZER is not the
 * thing doing the trimming and the clamp is the only mechanism under test. At Mantine
 * `size="sm"` this is comfortably wider than the dropdown, so it wraps to two lines
 * unless clamped. A short name would make both arms identical and the test vacuous.
 */
const LONG_NAME = 'Background Remover Pro Max Ultra Deluxe Special Edition Reissue';

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
const rect = (el: Element) => el.getBoundingClientRect();

beforeEach(() => {
  clearRecentlyOpenedApps();
});

describe('the desktop "Recently run" row does not wrap', () => {
  test(`at ${DESKTOP[0]}x${DESKTOP[1]} a ${LONG_NAME.length}-char app name renders on ONE line`, async () => {
    // 🔴 RED AT THIS PR'S OWN TIP (9bd9addf16), GREEN AT `origin/main` AND AT HEAD.
    // That three-way matrix is the point and it is stronger than a normal red/green
    // pair: `origin/main` passes because the pre-primitive chrome carried the clamp,
    // so this test is pinning RESTORED PARITY rather than new behaviour. The failing
    // assertion at the PR tip is the height comparison below — measured HERE as 78px
    // against the reference row's 35px, i.e. three lines. (The audit reported 56.7 vs
    // 33.6 for the same defect; the gap is the fixture, not a disagreement — this file
    // uses a 63-char name where the audit used a shorter one. Both are the same bug.)
    await page.viewport(...DESKTOP);
    // `null` owner: `useCurrentUser` is mocked to null above, so this is the bucket
    // the chrome will read back (the store is keyed per account, #4048).
    recordRecentlyOpenedApp({ id: 'ab-other', blockId: 'other-app', name: LONG_NAME }, null);

    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-clamp"
        appName="Host App"
        appBlockId="ab-current"
        slotId="app.page"
        canOpenPage
      />
    );
    await expect.element(page.getByTestId('app-block-chrome')).toBeInTheDocument();

    await page.getByTestId('app-platform-nav-trigger').click();
    await expect.element(page.getByRole('menuitem', { name: 'Marketplace' })).toBeInTheDocument();
    await expect.element(page.getByTestId('app-recently-run-item')).toBeInTheDocument();
    await frame();
    await frame();

    const recents = page.getByTestId('app-recently-run-item').element() as HTMLElement;
    // Guard-the-guard: without the stylesheet `lineClamp` is inert and BOTH arms
    // measure the same wrapped height, so this test would pass against the defect.
    expect(
      getComputedStyle(recents).display === 'flex' || getComputedStyle(recents).display === 'block',
      '@mantine/core/styles.css must be loaded — a Menu.Item with no stylesheet is not laid out'
    ).toBe(true);

    // The reference: a sibling row in the SAME dropdown whose label cannot wrap.
    const reference = page.getByRole('menuitem', { name: 'Marketplace' }).element() as HTMLElement;

    // 🔴 `+2` IS AN ICON ALLOWANCE, NOT A FUDGE, AND IT DOES NOT BLUNT THE GUARD. The
    // recents row's leftSection is a 16px `Avatar` where the reference row's is a 14px
    // icon, so the two one-line rows measure 34 and 35 — the first draft asserted
    // exact equality and failed 34-vs-35 against CORRECT code. The defect this test
    // exists for is a SECOND LINE, worth ~23px; a 2px allowance is an order of
    // magnitude below that, so the mutant still dies.
    const referenceHeight = Math.round(rect(reference).height);
    expect(
      Math.round(rect(recents).height),
      `at ${DESKTOP[0]}px the "Recently run" row must be within 2px of a one-line sibling ` +
        `(${referenceHeight}px) — an unclamped publisher name wraps to two lines and grows the ` +
        'dropdown by ~23px per row, ×5 rows'
    ).toBeLessThanOrEqual(referenceHeight + 2);

    // 🔴 THE FIXTURE-IS-LONG-ENOUGH CONTROL, MEASURED ON THE **BLOCK** AXIS, AND
    // DELIBERATELY AFTER THE ASSERTION ABOVE. Two things were wrong with the first
    // draft of it. It compared `scrollWidth > clientWidth` and failed 222 vs 222
    // against CORRECT code: `lineClamp` is `display: -webkit-box` +
    // `-webkit-line-clamp`, which clips VERTICALLY — the text still wraps inside its
    // box and never overflows horizontally, so that probe can never fire. And it ran
    // FIRST, so when the clamp was removed as a mutation this file went red on "the
    // clamped row must render a Mantine Text wrapper" — a precondition failing for
    // want of an element, which says nothing about layout. Ordered here, the mutant
    // dies on the height comparison, which is the behavioural claim.
    //
    // What it guards is the other direction: that a future shortening of `LONG_NAME`
    // cannot make the height comparison vacuously true. `scrollHeight > clientHeight`
    // is exactly "the content is taller than the one line it is being held to".
    const label = recents.querySelector('.mantine-Text-root') as HTMLElement | null;
    expect(label, 'the clamped row must render a Mantine Text wrapper').not.toBeNull();
    expect(
      (label as HTMLElement).scrollHeight,
      `the ${LONG_NAME.length}-char fixture must be TALLER than the one line it is clamped to, ` +
        'or the height comparison above would hold for a name that fits on one line anyway'
    ).toBeGreaterThan((label as HTMLElement).clientHeight);

    // And the dropdown as a whole did not grow. Stated separately because the row
    // equality above could in principle hold while some other box absorbed the height.
    const dropdown = document.querySelector('.mantine-Menu-dropdown') as HTMLElement | null;
    expect(
      dropdown,
      'the platform-nav dropdown must be in the document once opened'
    ).not.toBeNull();
    expect(
      Math.round(rect(dropdown as HTMLElement).height),
      'the dropdown must not be taller than the sum of one-line rows plus its two labels'
    ).toBeLessThan(215);
  });
});
