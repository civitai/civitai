/**
 * F3 — the app-block frame's NATIVE MOBILE SHELL, measured in a real browser at two
 * named viewports.
 *
 * Below the `sm` breakpoint (768, px scale) the full-page chrome stops being a
 * breadcrumb bar: a back chevron replaces the trail, the app name moves to the centre
 * and stays tappable, and the ⋮ becomes a bottom sheet that also carries the platform
 * nav folded into it. Above `sm` — and on the model-slot surface at every width —
 * nothing changes.
 *
 * 🔴 THE HARNESS WAS BLIND TO THIS DIMENSION AND WIDENING IT IS PART OF THE WORK.
 * `test/component-setup.tsx` sets no viewport, so every component test inherits
 * Vitest's default of **414×896** (`resolved.browser.viewport.width ??= 414`,
 * `vitest/dist/chunks/coverage.*.js`) — a phone, silently, in every suite that never
 * says otherwise. `AppsPageLayout.geometry.browser.test.tsx` pins 1440×900. So a
 * mobile spec written into either config would have passed or failed for reasons
 * nothing in the file named. Every test here states its viewport in its own title AND
 * in each assertion message, and the two sibling suites that assert the DESKTOP chrome
 * (`AppBlockChrome.browser.test.tsx`, `AppBlockChromePlatformNav.browser.test.tsx`)
 * were given an explicit desktop pin in the same change, for the same reason.
 *
 * 🔴 WHICH TESTS ARE REGRESSION COVERAGE AND WHICH ARE NOT — LABELLED PER TEST, AND
 * THE DISTINCTION IS NOT COSMETIC. Four fail at `origin/main` against the shipped
 * component for a BEHAVIOURAL reason (named in each). Several pass at `origin/main`
 * and are invariant guards — above all the resting-height pair, which is the whole
 * point of constraint 1 and would be worthless if it were counted as coverage of the
 * shell. Two more fail at `origin/main` only because the sheet does not exist there,
 * which proves nothing about behaviour; they are labelled SEAM/PARITY GUARD and are
 * explicitly not counted.
 *
 * 🔴 WHY THIS FILE LOADS `@mantine/core/styles.css`. Same reason the F1 responsive
 * suite does: the shared scaffold omits it on purpose, but every number here — the
 * bar's resting height, the `ActionIcon`'s `--ai-size-sm`, the Drawer's content box —
 * comes FROM that stylesheet, and without it each computes to something meaningless
 * while the assertions still pass. Vitest browser mode gives each file its own iframe,
 * so the import does not leak into sibling suites.
 */
import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as TrpcMod from '~/utils/trpc';
// Raw text, not a stylesheet import — see `safeAreaRuleText()` for why.
import globalsCss from '~/styles/globals.css?raw';

const mocks = vi.hoisted(() => ({
  features: { appListings: true } as Record<string, boolean>,
  detail: undefined as unknown,
}));

// The chrome gates its platform-nav "Review" item on the viewer's moderator flag and
// would otherwise throw for want of a CivitaiSessionContext. Anon, non-mod.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// 🔴 BOTH FLAG HOOKS, TO THE SAME OBJECT. `AppNameCrumb` and `ChromeReviewEntry` read
// through `useOptionalFeatureFlags` (fail-closed outside a provider); overriding only
// `useFeatureFlags` would leave them resolving the real null and every store-card
// assertion below would fail against a static `<Text>` for a reason unrelated to what
// it asserts. `importOriginal` spread rather than a wholesale object
// (local-rules/no-wholesale-module-mock): a hand-written module silently breaks every
// importer the day the real one grows an export this factory omits.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => mocks.features,
  useOptionalFeatureFlags: () => mocks.features,
}));

// The `blocks.*` namespace is reached by `AppPermissionsActivityDrawer`, which the
// parity test opens from a sheet row. Empty fixtures — its data-driven behaviour has
// its own suite; here it is only the target of an ACTION row.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      getAppDetail: { useQuery: () => ({ data: mocks.detail, isLoading: false, error: null }) },
      // Reached only by F4's entry points, which this file does not drive (that path
      // has its own suite). Present so a render cannot die on an undefined namespace.
      getMyReview: { useQuery: () => ({ data: null }) },
    },
    blocks: {
      listMyScopeGrants: { useQuery: () => ({ data: [], isLoading: false }) },
      listMyAppActivity: {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: [], nextCursor: null }] },
          isLoading: false,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
        }),
      },
      listMyScopeInvocations: {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: [], nextCursor: null }] },
          isLoading: false,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
        }),
      },
    },
    modelVersion: { getVersionsByIds: { useQuery: () => ({ data: undefined }) } },
    useQueries: () => [],
  },
}));

// eslint-disable-next-line import/first
import { AppBlockChrome } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import { CHROME_BAR_PX } from '~/components/AppBlocks/slotReservation';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
// eslint-disable-next-line import/first
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The two measurement points, named here and named again in every assertion message
 * so a failure says WHICH width it is about. A single point could not catch this
 * defect class in either direction: a shell that never appears and a shell that
 * appears everywhere both pass at one viewport.
 */
const PHONE: [number, number] = [360, 780];
const DESKTOP: [number, number] = [1440, 900];

const APP_NAME = 'Budgeted Generator';
const SLUG = 'budgeted-generator';

/** `ActionIcon size="sm"` at rest — `@mantine/core` 7.17.8's `--ai-size-sm` is 1.375rem. */
const RESTING_ICON_PX = 22;
/** 22 (ActionIcon sm) + 8 (`py={4}` ×2) + 1 (bottom border). See the height test. */
const CHROME_BAR_RENDERED_PX = RESTING_ICON_PX + 8 + 1;

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
const rect = (el: Element) => el.getBoundingClientRect();
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;

function detailFixture() {
  return {
    id: 'apl_01',
    slug: SLUG,
    name: APP_NAME,
    recommend: { recommendedCount: 9, notRecommendedCount: 1, recommendPct: 0.9 },
    reviewCount: 10,
  };
}

/**
 * Render the page-surface chrome at `viewport` and wait until its `ResizeObserver` has
 * measured the bar and committed the resulting shell decision.
 *
 * 🔴 THE WAIT IS ON `data-chrome-compact`, WHICH IS THE HAPPENS-BEFORE EVERY ABSENCE
 * ASSERTION IN THIS FILE RESTS ON. An absence checked with a POLLING matcher is
 * vacuous against async-gated UI — `expect.element(x).not.toBeInTheDocument()` retries
 * until it holds, and at t0 the element is legitimately absent for everyone, so it can
 * pass with the feature deleted. (That is exactly how three F4 mutants survived a
 * fully green file.) Here the chrome publishes its resolved decision as an attribute,
 * so waiting for that attribute to reach the expected value is a real observation of
 * the same state the assertion is about — after which every absence check below is a
 * SYNCHRONOUS `document.querySelector`, with no retry window to hide in.
 *
 * The poll is bounded (1.5s) rather than open-ended so that a run against code with no
 * such attribute at all — `origin/main` — falls through quickly to the behavioural
 * assertion instead of dying on a missing attribute and reporting a timeout where a
 * real failure message belongs.
 */
async function renderShell({
  viewport,
  expectCompact,
  ...props
}: {
  viewport: [number, number];
  expectCompact: boolean;
  slotId?: string;
  slug?: string;
  appBlockId?: string;
}) {
  await page.viewport(...viewport);
  renderWithProviders(
    <AppBlockChrome
      blockInstanceId="inst-mobile-shell"
      appName={APP_NAME}
      slotId="app.page"
      {...props}
    />
  );
  await expect.element(page.getByTestId('app-block-chrome')).toBeInTheDocument();
  const root = page.getByTestId('app-block-chrome').element() as HTMLElement;

  const want = expectCompact ? 'true' : 'false';
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && root.getAttribute('data-chrome-compact') !== want) {
    await frame();
  }
  // Two more frames so the re-render the measurement triggered has laid out.
  await frame();
  await frame();
  return root;
}

/**
 * Open the ⋮ and wait for its contents, at EITHER rendering.
 *
 * 🔴 IT WAITS ON A LABEL BOTH REVISIONS RENDER, NOT ON THE NEW SURFACE'S TESTID —
 * because a test that dies looking for something F3 introduced is red for a reason
 * that says nothing about behaviour. "Manage apps" is the ⋮'s own item at
 * `origin/main` and a sheet row here, so waiting on it means the assertions that
 * follow run against a populated surface at BOTH revisions, and the red lands on the
 * claim rather than on the lookup. Measured: the first draft waited on
 * `app-block-menu-dropdown` and every one of these tests failed at `origin/main` as a
 * 15-second timeout instead of an assertion.
 */
async function openOverflow() {
  await page.getByTestId('app-block-menu-trigger').click();
  await expect.element(page.getByText('Manage apps')).toBeInTheDocument();
}

/**
 * The ⋮'s content box, whichever rendering it got — a Drawer content box below `sm`,
 * a Menu dropdown above it (and at `origin/main`, at every width). Keyed on Mantine's
 * STATIC classes, which this app guarantees (`withStaticClasses` defaults true and is
 * not overridden), so the lookup does not depend on anything F3 added.
 */
function overflowBox(): HTMLElement | null {
  return q('.mantine-Drawer-content') ?? q('.mantine-Menu-dropdown');
}

/** The activatable rows of a surface, by their visible label. */
const rowLabels = (box: HTMLElement) =>
  [...box.querySelectorAll('a, button')].map((el) => (el.textContent ?? '').trim());

/**
 * Guard-the-guard. Without `@mantine/core/styles.css` the `Group` is not a flex row,
 * every width and height below reads as something other than what ships, and the
 * assertions can still pass. Asserted first in every test that measures anything.
 */
const styleSheetLoaded = (root: HTMLElement) => getComputedStyle(root).display === 'flex';

beforeEach(() => {
  mocks.features = { appListings: true };
  mocks.detail = detailFixture();
});

describe('AppBlockChrome mobile shell', () => {
  test(`REGRESSION — at ${PHONE[0]}x${PHONE[1]} the page chrome is a back chevron + centered name + ⋮, with NO breadcrumb`, async () => {
    // 🔴 RED AT `origin/main`, AND THE FAILING ASSERTION IS THE BREADCRUMB-ABSENCE
    // ONE — deliberately, because that is the half that fails BEHAVIOURALLY rather
    // than for want of a testid. At main the page surface renders
    // `app-block-breadcrumb` at every width, so `toBeNull()` fails there against a
    // real element. The chevron-presence assertions below it would also fail at main,
    // but only because the element does not exist yet, which says nothing about
    // behaviour — they are here to say WHAT replaced the trail, not to carry the red.
    const root = await renderShell({ viewport: PHONE, expectCompact: true });
    expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);

    expect(
      q('[data-testid="app-block-breadcrumb"]'),
      `at ${PHONE[0]}px the desktop breadcrumb trail must be GONE — the mobile shell replaces ` +
        'it, it does not sit alongside it'
    ).toBeNull();

    // …and the platform-nav trigger with it: the operator's call is that the nav
    // folds into the ⋮, so a second trigger in a 360px bar would be the thing this
    // change exists to remove.
    expect(
      q('[data-testid="app-platform-nav-trigger"]'),
      `at ${PHONE[0]}px there must be no separate platform-nav trigger — it folds into the ⋮`
    ).toBeNull();

    const back = q('[data-testid="app-block-back"]');
    expect(back, `at ${PHONE[0]}px the bar must offer a back affordance`).not.toBeNull();
    // A real anchor to the same destination the crumb pointed at. `getAttribute`
    // rather than `.href` so this reads the authored value, not a resolved absolute
    // URL that would also match a different route on a different origin.
    expect(
      (back as HTMLElement).getAttribute('href'),
      `at ${PHONE[0]}px the back chevron must point at the Marketplace, exactly as the crumb did`
    ).toBe('/apps');
    expect(
      (back as HTMLElement).getAttribute('aria-label'),
      'the back chevron is icon-only, so its accessible name is the only thing naming it'
    ).toBe('Back to Marketplace');

    // The name is still here, still the sanitized host-rendered one, and still a
    // control — the shell moves it, it does not drop it.
    const name = q('[data-testid="app-block-breadcrumb-name"]');
    expect(name, `at ${PHONE[0]}px the app name must still be rendered by the host`).not.toBeNull();
    expect((name as HTMLElement).textContent).toContain(APP_NAME);

    expect(
      q('[data-testid="app-block-menu-trigger"]'),
      `at ${PHONE[0]}px the ⋮ overflow must still be reachable`
    ).not.toBeNull();

    // Provenance survives the loss of the platform-nav trigger it used to live in.
    // This is the spoof-proofing the whole bar exists for, and it is the thing most
    // likely to be dropped silently by a layout change.
    const provenance = [...root.querySelectorAll('[aria-label="App"]')];
    expect(
      provenance.length,
      `at ${PHONE[0]}px exactly one element must carry the "App" provenance label`
    ).toBe(1);

    // The row still does not overflow: three items, one line, 360px.
    expect(root.scrollWidth, `no horizontal overflow at ${PHONE[0]}px`).toBeLessThanOrEqual(
      root.clientWidth + 1
    );
  });

  test(`INVARIANT GUARD — at ${DESKTOP[0]}x${DESKTOP[1]} the breadcrumb chrome is untouched and there is no chevron`, async () => {
    // 🔴 NOT REGRESSION COVERAGE — `origin/main` passes every line of this, and that
    // is the point: it is the "do not change desktop behaviour" constraint written
    // down. Its killing mutation is dropping the `geometry.compact` term (or the
    // `isPage &&` in front of it) so the shell renders at every width, which this
    // catches and the phone test above cannot.
    const root = await renderShell({ viewport: DESKTOP, expectCompact: false });
    expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);

    expect(
      q('[data-testid="app-block-breadcrumb"]'),
      `at ${DESKTOP[0]}px the breadcrumb trail must still render`
    ).not.toBeNull();
    expect(
      q('[data-testid="app-block-breadcrumb-apps"]')?.getAttribute('href'),
      `at ${DESKTOP[0]}px the leading crumb must still link to /apps`
    ).toBe('/apps');
    expect(
      q('[data-testid="app-platform-nav-trigger"]'),
      `at ${DESKTOP[0]}px the platform-nav trigger must still be its own control`
    ).not.toBeNull();
    expect(
      q('[data-testid="app-block-back"]'),
      `at ${DESKTOP[0]}px there must be NO back chevron — the breadcrumb is the back affordance`
    ).toBeNull();
  });

  test(`INVARIANT GUARD — at ${PHONE[0]}x${PHONE[1]} the MODEL-slot chrome is untouched, narrow though it is`, async () => {
    // 🔴 NOT REGRESSION COVERAGE — green at `origin/main`. It is the SURFACE control,
    // and it is the only thing that kills the most tempting mutation in this change:
    // dropping the `isPage &&` term from `const compact = isPage && geometry.compact`.
    // Every other test in this file passes with that term gone, because they all render
    // the page surface — and the model slot would silently acquire a back chevron
    // pointing at the Marketplace from a model page nobody reached the store from,
    // plus a folded nav in place of its own.
    //
    // The distinction is real and deliberate: `geometry.compact` is TRUE here (a 360px
    // bar is narrow by any measure, and the model sidebar is narrower still). What
    // gates the shell is the SURFACE, because the shell replaces a breadcrumb only the
    // full-page surface has. See `chromeGeometry.ts`'s `compact` doc comment.
    await page.viewport(...PHONE);
    // No `slotId` → the model surface (the chrome's documented back-compat default).
    renderWithProviders(<AppBlockChrome blockInstanceId="inst-model-narrow" appName={APP_NAME} />);
    await expect.element(page.getByTestId('app-block-chrome')).toBeInTheDocument();
    const root = page.getByTestId('app-block-chrome').element() as HTMLElement;
    // Let the ResizeObserver measure and commit, so this is a claim about the SETTLED
    // render rather than about the first paint (where nothing is compact anyway).
    await frame();
    await frame();
    await frame();
    expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);

    expect(
      root.getAttribute('data-chrome-compact'),
      `a ${PHONE[0]}px MODEL-slot bar must not take the mobile shell — the shell replaces a ` +
        'breadcrumb this surface does not have, and "back to the Marketplace" is not a ' +
        'meaningful action from a model page'
    ).toBe('false');
    expect(
      q('[data-testid="app-block-back"]'),
      'the model slot must have no back chevron at any width'
    ).toBeNull();
    expect(
      q('[data-testid="app-platform-nav-trigger"]'),
      'the model slot keeps its own platform-nav trigger at any width'
    ).not.toBeNull();
    expect(
      q('[data-testid="app-block-name"]'),
      'the model slot keeps its badge app-name label at any width'
    ).not.toBeNull();
  });

  test(`REGRESSION — at ${PHONE[0]}x${PHONE[1]} the platform nav is inside the ⋮ sheet`, async () => {
    // 🔴 RED AT `origin/main`, BEHAVIOURALLY. The failing assertion is the presence of
    // "Installed apps" after opening the ⋮. That label exists ONLY in the platform-nav
    // section — the ⋮ menu's own item for the same route is worded "Manage apps" — so
    // at main, where the ⋮ carries app actions only, it is not reachable from this
    // trigger at any width.
    //
    // 🔴 IT IS ASSERTED BY LABEL, NOT BY A TESTID, ON PURPOSE. A testid on the new
    // sheet would go red at main merely by not existing, which proves nothing. A user-
    // visible label that main renders behind a DIFFERENT trigger is a claim about
    // where the nav lives, which is what the operator actually decided.
    const root = await renderShell({ viewport: PHONE, expectCompact: true });
    expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);

    // Happens-before for everything below: a label the ⋮ carries at BOTH revisions.
    // Waiting on that (rather than on the item under test) is what stops the
    // assertions from being satisfied by a retry window, and what keeps the red
    // behavioural.
    await openOverflow();
    const sheet = overflowBox();
    expect(sheet, 'the ⋮ must have opened SOME surface').not.toBeNull();

    const labels = rowLabels(sheet as HTMLElement);
    for (const label of ['Marketplace', 'Installed apps', 'My apps']) {
      expect(
        labels,
        `at ${PHONE[0]}px "${label}" must be reachable from the ⋮ — the platform nav folds into ` +
          'it because the mobile bar has no second trigger'
      ).toContain(label);
    }
    // …and the ⋮'s own items are still there beside them, so the fold ADDED rather
    // than replaced. Without this the test would pass on a ⋮ that had become a
    // platform-nav menu and lost its app actions.
    expect(
      labels,
      `at ${PHONE[0]}px the ⋮ must still carry its own app actions alongside the folded nav`
    ).toContain('Manage apps');

    // The sheet is a real bottom-sheet Drawer, not a dropdown wearing a testid.
    const content = q('.mantine-Drawer-content');
    expect(
      content,
      `at ${PHONE[0]}px the ⋮ must open a Drawer (the site's bottom-sheet idiom), not a dropdown`
    ).not.toBeNull();
    expect(
      q('.mantine-Menu-dropdown'),
      `at ${PHONE[0]}px the ⋮ must NOT also render a dropdown — the sheet replaces it`
    ).toBeNull();
  });

  test(`INVARIANT GUARD — at ${DESKTOP[0]}x${DESKTOP[1]} the nav stays in its own menu and the ⋮ does not absorb it`, async () => {
    // 🔴 NOT REGRESSION COVERAGE — green at `origin/main`. It is the control arm for
    // the test above: without it, "the nav is in the ⋮" cannot be told apart from "the
    // nav is in the ⋮ at every width", and a mutant that dropped the `compact &&` in
    // front of the folded section would pass the phone test and ship a duplicated nav
    // on desktop.
    const root = await renderShell({ viewport: DESKTOP, expectCompact: false });
    expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);

    // Wait for an item that IS in this menu at both revisions. That is the
    // happens-before: once "Manage apps" is present the dropdown has rendered its
    // children, so the absence below is measured against a populated surface rather
    // than an empty one.
    await openOverflow();
    const overflow = overflowBox();
    expect(overflow, 'the ⋮ must have opened SOME surface').not.toBeNull();
    expect(
      rowLabels(overflow as HTMLElement),
      `at ${DESKTOP[0]}px the ⋮ must NOT carry the platform nav — it has its own trigger here`
    ).not.toContain('Marketplace');

    // …and that trigger opens a menu which does.
    await page.getByTestId('app-platform-nav-trigger').click();
    await expect.element(page.getByRole('menuitem', { name: 'Marketplace' })).toBeInTheDocument();
  });

  test(`REGRESSION — at ${PHONE[0]}x${PHONE[1]} the app name opens the store card as a bottom SHEET`, async () => {
    // 🔴 RED AT `origin/main`, AND THE STRUCTURAL HALF IS WHAT CARRIES THE RED. Main
    // renders the same card with the same testids at 360px — as a POPOVER. So the
    // content assertions below pass at main and are NOT the coverage; the assertion
    // that the card's box is inside `.mantine-Drawer-content` is, and it fails at main
    // against a `.mantine-Popover-dropdown`.
    //
    // The content assertions are here because a structural check alone would be
    // satisfied by an empty sheet — F2's rollup and store link have to still work
    // INSIDE the new surface, which is constraint 4.
    const root = await renderShell({ viewport: PHONE, expectCompact: true, slug: SLUG });
    expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);

    await page.getByTestId('app-block-breadcrumb-name').click();
    await expect.element(page.getByTestId('app-block-name-popover')).toBeInTheDocument();
    const card = q('[data-testid="app-block-name-popover"]') as HTMLElement;

    const drawer = q('.mantine-Drawer-content');
    expect(
      drawer,
      `at ${PHONE[0]}px the app-name card must be delivered as a bottom sheet, not a popover`
    ).not.toBeNull();
    expect(
      (drawer as HTMLElement).contains(card),
      `at ${PHONE[0]}px the app-name card must render INSIDE the drawer content box`
    ).toBe(true);
    expect(
      q('.mantine-Popover-dropdown'),
      `at ${PHONE[0]}px no popover may be rendered — the sheet replaces it`
    ).toBeNull();

    // F2 still works in there: the full name, the shared recommend rollup, and the
    // store link built by `getListingDetailHref`.
    expect(q('[data-testid="app-block-name-popover-name"]')?.textContent).toBe(APP_NAME);
    expect(
      q('[data-testid="app-block-name-popover-recommend"]')?.textContent,
      'the rollup must come from the SHARED store formatter, so the frame and the store cannot ' +
        'disagree about one app'
    ).toContain('90%');
    const storeLink = q('[data-testid="app-block-name-popover-store-link"]');
    expect(
      storeLink,
      'the "View in App Store" action must survive inside the sheet'
    ).not.toBeNull();
    expect((storeLink as HTMLElement).getAttribute('href')).toContain(SLUG);
  });

  test(`PARITY GUARD — at ${PHONE[0]}x${PHONE[1]} activating a sheet row closes the sheet`, async () => {
    // 🔴 NOT COUNTED AS REGRESSION COVERAGE: it fails at `origin/main` only because
    // there is no sheet there, which says nothing about behaviour. What it pins is a
    // PARITY the sheet has to supply for itself — Mantine's `closeOnItemClick` closes
    // a `Menu` on item activation and a `Drawer` has no equivalent, so without the
    // explicit close in `ChromeSurfaceItem` a tap would leave a full-height sheet
    // sitting over the app, and (on the review row) behind a focus-trapping modal.
    //
    // Its killing mutation is deleting that `close()` call, which nothing else here
    // would notice.
    //
    // 🔴 THE ROW CLICKED IS AN ACTION, NOT A LINK, AND THAT IS FORCED RATHER THAN
    // ARBITRARY. `NextLink` renders a REAL anchor; clicking one in browser mode
    // navigates the test iframe and the run dies with "Cannot connect to the iframe"
    // — measured, on the first draft of this test with "My apps". An action row
    // ("Permissions & activity", which needs `appBlockId` threaded) exercises exactly
    // the same `ChromeSurfaceItem` close path with nothing to navigate to.
    await renderShell({ viewport: PHONE, expectCompact: true, appBlockId: 'ab_1' });

    await openOverflow();
    // 🔴 A POSITIVE PRECONDITION, NOT DECORATION. The assertion at the end of this
    // test is an ABSENCE, and an absence is trivially satisfied by a surface that
    // never opened — at `origin/main` there is no sheet at all, so without this line
    // the test would pass there while proving nothing. Requiring the sheet FIRST is
    // what makes the later `toBeNull()` mean "it closed" rather than "it never was".
    const sheet = q('.mantine-Drawer-content');
    expect(
      sheet,
      `at ${PHONE[0]}px the ⋮ must open a bottom sheet before this test can say anything about ` +
        'the sheet closing'
    ).not.toBeNull();

    const action = [...(sheet as HTMLElement).querySelectorAll('a, button')].find(
      (el) => (el.textContent ?? '').trim() === 'Permissions & activity'
    ) as HTMLElement | undefined;
    expect(
      action,
      'the "Permissions & activity" row must be present to click — it is threaded via `appBlockId`'
    ).not.toBeUndefined();
    (action as HTMLElement).click();

    // Real happens-before for the absence: Mantine unmounts a closed Drawer's content
    // after its exit transition, so poll the same node until it is gone rather than
    // asserting immediately (which would pass on a sheet that never closes if the
    // check ran before any commit) or with a bare polling matcher.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && q('[data-testid="app-block-menu-dropdown"]') !== null) {
      await frame();
    }
    expect(
      q('[data-testid="app-block-menu-dropdown"]'),
      'activating a row must close the sheet — a Drawer has no `closeOnItemClick`, so the row ' +
        'has to close it explicitly'
    ).toBeNull();
  });

  /**
   * 🔴 NOT REGRESSION COVERAGE — a SEAM GUARD, and the seam is between two things
   * neither of which this change wrote. `src/styles/globals.css` already pays the
   * bottom inset for every Mantine drawer in the app at the LIBRARY seam
   * (`@layer mantine { .mantine-Drawer-content { padding-bottom:
   * var(--safe-area-inset-bottom) } }`), so the correct thing for a new sheet to do is
   * NOTHING — paying it again would double it on a notched phone. That makes "the
   * sheet respects the inset" a claim about COVERAGE rather than about code this
   * change contains, and a claim of that shape is exactly the kind that goes stale
   * invisibly: the sheet stays covered right up until someone gives it a `styles`
   * override for its content slot.
   *
   * So the test asserts the resolved outcome on the real rendered sheet, and it
   * asserts it in a way that dies if EITHER side moves: the rule is read out of
   * `globals.css` itself (deleting it there fails the extraction), and the padding is
   * measured on the live element (overriding it in `ChromeSurface` fails the
   * measurement). The repo-wide `viewport-fit-cover.test.ts` owns the complementary
   * half — that nothing outranks that rule anywhere in `src`, in the real cascade.
   *
   * It fails at `origin/main` only because no sheet exists there. Not counted.
   */
  describe('the sheet respects --safe-area-inset-bottom', () => {
    /**
     * The `.mantine-Drawer-content` declaration block, read out of `globals.css`.
     *
     * 🔴 PARSED BY THE BROWSER, NOT BY A REGEX, for the reason `test/component-setup.tsx`
     * gives at length: several successive regex attempts to carve a block out of that
     * same file each shipped a defect, because comments, strings and nesting make
     * "where does this block end" a question only the engine can answer.
     *
     * 🔴 AND IT THROWS RATHER THAN RETURNING EMPTY. A missing rule would otherwise
     * inject nothing, the padding would measure `0px`, and the test would fail with a
     * number — reading as "the sheet lost its inset" when the truth is "the global
     * payment was deleted". Those are different repairs, so they get different
     * failures.
     */
    function safeAreaRuleText(): string {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(globalsCss);
      const found: string[] = [];
      const walk = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule) {
            if (rule.selectorText.includes('.mantine-Drawer-content')) found.push(rule.cssText);
          } else if (
            typeof CSSLayerBlockRule !== 'undefined' &&
            rule instanceof CSSLayerBlockRule
          ) {
            // `@layer` only orders the cascade — descend. `@media`/`@supports` are
            // conditional and are deliberately not descended into: a rule that only
            // applies under a condition is not evidence of an unconditional payment.
            walk(rule.cssRules);
          }
        }
      };
      walk(sheet.cssRules);
      const paying = found.filter((t) =>
        /padding-bottom:\s*var\(--safe-area-inset-bottom\)/.test(t)
      );
      if (paying.length === 0) {
        throw new Error(
          'src/styles/globals.css no longer pays `padding-bottom: var(--safe-area-inset-bottom)` ' +
            'on `.mantine-Drawer-content`. That rule is what covers EVERY bottom sheet in the app, ' +
            'including the app-block chrome’s. If it moved, re-point this guard; if it was ' +
            'deleted, the last row of ~26 bottom drawers now sits under the home indicator.'
        );
      }
      return paying.join('\n');
    }

    /**
     * Apply the real rule plus a NON-ZERO inset. `env(safe-area-inset-bottom)` is 0 in
     * a headless desktop Chromium with no display cutout, so measuring the shipped
     * value would compare `0px` against `0px` — green with the whole mechanism
     * removed, the reassuring-zero shape. Overriding the custom property is what makes
     * the measurement able to fail.
     *
     * 🔴 INJECTED UNLAYERED, AND THAT IS A DELIBERATE FIDELITY LIMIT WORTH STATING.
     * The app imports `@mantine/core/styles.layer.css`; this harness imports the
     * UNLAYERED `@mantine/core/styles.css`, so re-injecting the rule inside
     * `@layer mantine` here would lose to Mantine's own unlayered declarations and
     * measure the wrong thing. This test therefore proves "the rule, applied, reaches
     * this sheet and nothing in our component overrides it" — NOT "it wins the real
     * cascade". That second claim is `viewport-fit-cover.test.ts`'s, which reads the
     * actual layer order out of the real files.
     */
    function injectInset(px: number): HTMLStyleElement {
      const style = document.createElement('style');
      style.setAttribute('data-source', 'AppBlockChromeMobileShell:safe-area');
      style.textContent = `:root { --safe-area-inset-bottom: ${px}px; }\n${safeAreaRuleText()}`;
      document.head.appendChild(style);
      return style;
    }

    test(`at ${PHONE[0]}x${PHONE[1]} the ⋮ sheet's content box pays the bottom inset, and TRACKS it`, async () => {
      const style = injectInset(34);
      try {
        await renderShell({ viewport: PHONE, expectCompact: true });
        await openOverflow();

        const content = q('.mantine-Drawer-content');
        expect(
          content,
          'the ⋮ sheet must be a Mantine Drawer — the global inset rule is keyed on that class, ' +
            'so a hand-rolled sheet would be silently unpaid'
        ).not.toBeNull();

        expect(
          getComputedStyle(content as HTMLElement).paddingBottom,
          `at ${PHONE[0]}px the sheet must pay the full ${34}px inset, so its last row is not ` +
            'under the home indicator where iOS eats the tap'
        ).toBe('34px');

        // 🔴 THE CONTROL THAT MAKES THE NUMBER ABOVE MEAN SOMETHING. A component that
        // hardcoded `paddingBottom: 34` would pass the assertion above and fail here.
        // Changing the custom property needs no re-render — the cascade re-resolves —
        // so this measures the SAME element twice with only the inset varied.
        style.textContent = `:root { --safe-area-inset-bottom: 12px; }\n${safeAreaRuleText()}`;
        await frame();
        expect(
          getComputedStyle(content as HTMLElement).paddingBottom,
          'the sheet’s bottom padding must TRACK `--safe-area-inset-bottom` rather than ' +
            'happening to equal it — a fixed value passes the first assertion and fails this one'
        ).toBe('12px');
      } finally {
        style.remove();
      }
    });
  });

  /**
   * 🔴 CONSTRAINT 1, AND NOT REGRESSION COVERAGE — both cases pass at `origin/main`
   * and are supposed to. `CHROME_BAR_PX` in `slotReservation.ts` pins the bar's
   * resting height as the model slot's CLS reservation and is asserted in a GATING
   * node-tier test, so the mobile shell must not move it. This checks that at a
   * rendered-pixel level, at both viewports, rather than by reading a constant back.
   *
   * 🔴 IT PINS THE MEASURED HEIGHT, NOT `CHROME_BAR_PX`, AND THOSE TWO DISAGREE — a
   * PRE-EXISTING divergence F1 found and deliberately did not fix. `slotReservation.ts`
   * derives 35 from `--ai-size-sm = 26px`; the installed `@mantine/core` 7.17.8 ships
   * `--ai-size-sm: calc(1.375rem * var(--mantine-scale))` = 22px and this repo
   * overrides neither, so the real height is 22 + 8 + 1 = 31 and the slot
   * OVER-reserves by 4px. Over-reserving is the safe direction for a CLS reserve (a
   * small dead gap, never a shift). `CHROME_BAR_PX` is untouched by this change; the
   * inequality below is what stops the gap silently inverting into an UNDER-reserve.
   *
   * Two cases, not one loop: `cleanup()` runs per TEST, so two renders inside one test
   * would leave two chrome bars in the document and every document-scoped query would
   * be ambiguous.
   */
  test.each([
    ['phone (mobile shell)', PHONE, true],
    ['desktop (breadcrumb chrome)', DESKTOP, false],
  ] as const)(
    `INVARIANT GUARD — the bar's resting height is ${CHROME_BAR_RENDERED_PX}px at the %s viewport`,
    async (_label, viewport, expectCompact) => {
      const root = await renderShell({ viewport, expectCompact });
      expect(styleSheetLoaded(root), '@mantine/core/styles.css must be loaded').toBe(true);

      // 🔴 THIS PAIR DELIBERATELY DOES NOT ASSERT `data-chrome-compact`, EVEN THOUGH
      // AN EARLIER DRAFT DID. That attribute does not exist at `origin/main`, so
      // asserting it turned an invariant guard — a test whose whole value is that it
      // is green on BOTH sides — into one that fails at base for want of an attribute.
      // A guard that cannot be green at base cannot tell you the height did not move.
      // Which shell each viewport renders is established by the two structural tests
      // at the top of this file, so this pair is not measuring one shell twice.
      expect(
        Math.round(rect(root).height),
        `the chrome bar's resting height must not move at ${viewport[0]}px — it is the model ` +
          'slot’s CLS reservation (`CHROME_BAR_PX`)'
      ).toBe(CHROME_BAR_RENDERED_PX);
      expect(
        CHROME_BAR_PX,
        'the reservation must stay an OVER-reservation, never an under-reservation'
      ).toBeGreaterThanOrEqual(CHROME_BAR_RENDERED_PX);

      // The bar's own controls are still at their resting size at both widths — the
      // shell must not have bought its layout by shrinking the tap targets.
      const trailing = q('[data-testid="app-block-menu-trigger"]') as HTMLElement;
      expect(
        Math.round(rect(trailing).width),
        `the ⋮ trigger must render at its resting ActionIcon size="sm" at ${viewport[0]}px`
      ).toBe(RESTING_ICON_PX);
    }
  );
});
