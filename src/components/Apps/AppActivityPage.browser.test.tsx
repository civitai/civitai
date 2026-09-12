import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useRouter } from 'next/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';

/**
 * `/apps/activity` — the PAGE, mounted for real.
 *
 * Three acceptance criteria live here because none of them is observable from a pure
 * module: whether the `Installs` TAB renders, which tab the page OPENS on, and whether
 * the header still carries a marketplace CTA.
 *
 * ── RED AT `origin/main` ──────────────────────────────────────────────────────
 * Measured by pointing this file at `origin/main`'s `pages/apps/installed.tsx` (the
 * pre-rename file) with the rest of this branch in place. Every test below fails there,
 * and each for the reason it names:
 *   · `opens on Recent activity` — main renders `<Tabs defaultValue="subscriptions">`;
 *   · `?tab=…` — main's tabs are UNCONTROLLED and read no query at all;
 *   · `Installs is absent without appBlocks` — main renders the tab unconditionally
 *     (and would 404 the whole page for that viewer, which is criterion 2's half);
 *   · `no header CTA` — main renders `actions={<Button …>Browse marketplace</Button>}`.
 * The exact per-test messages are in the PR body.
 *
 * ── LATER ADDITION: `Hidden`, then `Apps & permissions`, join the SLOT gate ────
 * `Hidden` lists slot installs the viewer has hidden from their model pages, so it
 * carries `features.appBlocks` exactly as `Installs` does. Its red-at-previous-state is
 * `the exact ledger` case below and the stale-link case, which rendered a bar with
 * NOTHING selected until `resolveActivityTab` stopped testing the gated tab BY NAME.
 *
 * 🔴 `Apps & permissions` IS NOW GATED TOO, AND AN EARLIER REVISION OF THIS FILE ARGUED
 * THE OPPOSITE. The retracted premise was that a page-flag-only viewer has scope grants
 * to read. They do not: `ScopeGrantsPanel`'s only read is `blocks.listMyScopeGrants`,
 * whose `enforceAppBlocksFlag` middleware evaluates the `app-blocks-enabled` Flipt key —
 * exactly `features.appBlocks` — and returns `[]` without it, so the tab showed that
 * cohort an empty state, always. `AppsSubNav.tsx` had already retracted the same premise
 * for the same cohort (they cannot run a full-page app: `/apps/run/[slug]/[[...path]]`
 * requires BOTH flags). Gating it displays nothing that was ever displayed.
 *
 * ── CONSEQUENCE: THE BAR NOW COLLAPSES ────────────────────────────────────────
 * With three of four tabs gated, a slotless viewer is left with `Recent activity` alone,
 * so the page hides its `Tabs.List` below two visible tabs (mirroring `AppsSubNav`'s
 * `links.length < 2`). Every slotless arm below therefore waits on a PANEL, not a tab —
 * there is no `role="tab"` to wait for, and a `getByRole('tab')` there would hang to
 * timeout and read as a broken page.
 *
 * ── WHY THE MOCKS ARE THESE MOCKS ─────────────────────────────────────────────
 * The page module calls `createServerSideProps` at import time, which pulls the server
 * graph into a browser bundle — stubbed, exactly as `AppsWideLayout.geometry.test.tsx`
 * does for the same import. `trpc` is a PROXY rather than a hand-enumerated tree: the
 * page plus its sub-nav plus three panels touch a dozen procedures between them, and a
 * literal mock fails with `Cannot read properties of undefined` for every one nobody
 * remembered — a fixture problem masquerading as a component problem.
 */

const mocks = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  /** Shared `mutate` spy for every `useMutation` in the tree — the budget editor is the
   *  only mutation these tests drive, and they clear it first. */
  mutate: vi.fn(),
}));

/**
 * 🔴 THE SCAFFOLD'S SHARED ROUTER, NOT A LOCAL `vi.mock('next/router', …)`. A
 * file-level router mock SILENTLY LOSES to `test/component-setup.tsx`'s (setup files
 * register last and are not overridden here): `router.query` stays `{}` forever, so a
 * `?tab=` test can never select anything and reads as a broken feature. That exact trap
 * is recorded on `AppEditPage.browser.test.tsx`, which hit it first.
 */
// `useRouter` here is the scaffold's MOCK (test/component-setup.tsx), which returns a plain
// singleton object and calls no React hook. Reading it once at module scope is the
// established idiom in this suite — see `AppEditPage.browser.test.tsx` and
// `src/tests/pages/payment/success.browser.test.tsx`.
// eslint-disable-next-line react-hooks/rules-of-hooks -- see above
const router = useRouter();

vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.flags,
  useOptionalFeatureFlags: () => mocks.flags,
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'viewer', isModerator: false }),
}));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-mock).
vi.mock('~/utils/trpc', async (importOriginal) => {
  const inert = {
    data: undefined,
    error: null,
    isLoading: false,
    isFetching: false,
    isPending: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    invalidate: vi.fn(),
  };
  /**
   * The reads whose CONTENT this file depends on — everything else is inert.
   *
   * 🔴 VALUES ARE THUNKS, EVALUATED PER `useQuery` CALL, so an arm's flags can decide
   * what a procedure returns. A fixture that hard-codes the SAME value in every flag arm
   * cannot observe the mutant that matters: it can only ever produce the constant's own
   * value, so the assertion is blind to whether the server would have refused the read.
   */
  const DATA: Record<string, () => unknown> = {
    // EMPTY on purpose: the empty states are where the surviving marketplace anchors
    // live, and their presence is one of the criteria under test.
    'blocks.listMySubscriptions': () => [],
    // 🔴 MIRRORS `enforceAppBlocksFlag`, NOT A CONSTANT. The real procedure evaluates the
    // `app-blocks-enabled` Flipt key — exactly `features.appBlocks` — and short-circuits
    // to `[]` without it. Encoding that here is what makes "the permissions panel is
    // empty for a slotless viewer" a consequence of the flag rather than of the fixture.
    'blocks.listMyScopeGrants': () =>
      mocks.flags.appBlocks
        ? [
            {
              appBlockId: 1,
              blockId: 'demo-block',
              name: 'Demo App',
              slug: 'demo-app',
              scopes: ['read:profile'],
              surfaces: { modelInstallCount: 1, subscriptionScopes: [] },
              // No spend scope granted → no budget control on this card. Keeping one
              // such row is what makes the control's presence on the OTHER row a fact
              // about `spendScopeGranted` rather than about the panel rendering at all.
              buzzBudgetPerDay: null,
              spendScopeGranted: false,
            },
            {
              appBlockId: 'apb_spend',
              blockId: 'spender',
              name: 'Spender',
              slug: 'spender',
              scopes: ['ai:write:budgeted'],
              surfaces: { modelInstallCount: 0, subscriptionScopes: ['viewer_personal'] },
              buzzBudgetPerDay: 750,
              spendScopeGranted: true,
            },
            // 🔴 THE GRANT-ONLY SHAPE — `0` installs AND `0` subscription scopes. This is the
            // row `listMyScopeGrants` only began emitting when it started enumerating
            // `app_user_scope_grants`, and by the production counts it is the DOMINANT
            // population, not an edge case. Without it no fixture at this tier renders the
            // card the change exists to create, so a regression in how it renders — the
            // surface line, the budget control, an empty scope list — ships green.
            // Distinct from `apb_spend` in exactly the field under test: that row also has
            // `modelInstallCount: 0` but carries a subscription scope, so it cannot
            // exercise the `0 / 0` branch of `buildSurfaceLine`.
            //
            // 🔴 `spendScopeGranted: false` DELIBERATELY, and this is a REAL COVERAGE GAP,
            // not a tidy choice — recorded rather than glossed. With it `true` the card
            // renders an `AppBudgetControl` (a null budget still emits `app-budget-row` AND
            // `app-budget-value`, showing the "none" copy), which would flip the two
            // `toHaveLength(1)` assertions below to 2 and make `app-budget-edit` ambiguous
            // for the Save test's `.click()`. Those counts are the discriminating half of
            // the budget tests, so quietly relaxing them to 2 would weaken a real guard to
            // admit a fixture. RESIDUAL: no component-tier case renders a budget control on
            // a GRANT-ONLY card. That combination is covered at the service tier
            // (`user-app-surface.orchestration.test.ts` asserts `spendScopeGranted: true`
            // plus a budget for a grant-only row), and the service tier cannot see the card.
            {
              appBlockId: 'apb_grant_only',
              blockId: 'consented',
              name: 'Consented Only',
              slug: 'consented-only',
              scopes: ['ai:write:budgeted'],
              surfaces: { modelInstallCount: 0, subscriptionScopes: [] },
              buzzBudgetPerDay: null,
              spendScopeGranted: false,
            },
          ]
        : [],
    'blocks.listMyAppActivity': () => ({ pages: [{ items: [], nextCursor: null }] }),
    'blocks.listMyScopeInvocations': () => ({ pages: [{ items: [], nextCursor: null }] }),
    'blocks.getNavSummary': () => ({
      hasInstalls: true,
      hasActivity: true,
      hasSubmissions: false,
      hasApprovedApps: false,
      isReviewer: false,
      hasEditableApps: false,
      hasPendingInvites: false,
    }),
  };
  const node = (read?: () => unknown): unknown =>
    new Proxy(
      {},
      {
        get(_t, key: string) {
          if (key === 'useQuery' || key === 'useInfiniteQuery') {
            // Called at RENDER time, so `mocks.flags` is the arm's own value.
            return () => (read === undefined ? inert : { ...inert, data: read() });
          }
          if (key === 'useMutation') return () => ({ ...inert, mutate: mocks.mutate });
          if (key === 'invalidate' || key === 'fetch') return vi.fn();
          if (key === 'then') return undefined; // never look thenable to await
          return node();
        },
      }
    );
  const root: unknown = new Proxy(
    {},
    {
      get(_t, router: string) {
        if (router === 'useUtils') return () => node();
        if (router === 'useQueries') return () => [];
        if (router === 'then') return undefined;
        return new Proxy(
          {},
          {
            get(_t2, proc: string) {
              if (proc === 'then') return undefined;
              return node(DATA[`${router}.${proc}`]);
            },
          }
        );
      },
    }
  );
  return { ...(await importOriginal<typeof TrpcMod>()), trpc: root };
});

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

// The page renders `<Meta>`, which calls `useBrowserRouter()` — that hook THROWS
// ('missing context') without a `BrowserRouterProvider`, which `renderWithProviders`
// deliberately doesn't mount. Unmocked it takes the whole page render down (empty
// <body>), so every assertion burns its timeout. Same stub `AppEditPage.browser.test.tsx`
// uses, for the same reason.
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
// Stubbed so the refused-viewer case asserts on a marker this file owns rather than on
// whatever copy the shared 404 currently carries.
vi.mock('~/components/AppLayout/NotFound', () => ({
  NotFound: () => <div data-testid="mock-notfound">not found</div>,
}));

const AppActivityPage = (await import('~/pages/apps/activity')).default;

/** The page's OWN tabs, not the `/apps/*` sub-nav (a `nav` landmark, role `tab` too). */
const pageTabs = () =>
  Array.from(document.querySelectorAll('[role="tab"]')).filter((el) => !el.closest('nav'));

const pageTab = (label: string) => pageTabs().find((el) => (el.textContent ?? '').trim() === label);

const selectedPageTab = () => pageTabs().find((el) => el.getAttribute('aria-selected') === 'true');

/** Anchors to `/apps` OUTSIDE the sub-nav — i.e. the page's own marketplace links. */
const bodyMarketplaceLinks = () =>
  Array.from(document.querySelectorAll('a[href="/apps"]')).filter((el) => !el.closest('nav'));

beforeEach(() => {
  mocks.flags = { appBlocks: true, appBlocksPages: true, appListings: true };
  router.query = {};
  router.pathname = '/apps/activity';
  vi.mocked(router.replace).mockClear();
});

describe('the page opens on Recent activity', () => {
  test('🔴 with no ?tab, Recent activity is the selected tab', async () => {
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    expect(selectedPageTab()?.textContent?.trim()).toBe('Recent activity');
  });

  test('🔴 NEGATIVE CONTROL: ?tab= really can select a DIFFERENT tab', async () => {
    // Without this, the assertion above is satisfied by a page that ignores the query
    // entirely and happens to default to the right tab — which is half of what
    // `origin/main` did.
    router.query = { tab: 'permissions' };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    expect(selectedPageTab()?.textContent?.trim()).toBe('Apps & permissions');
  });

  test('🔴 a repeated / unknown ?tab falls back rather than selecting nothing', async () => {
    router.query = { tab: 'no-such-tab' };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    expect(selectedPageTab()?.textContent?.trim()).toBe('Recent activity');
  });

  test('🔴 switching a tab REWRITES the URL (replace, not push)', async () => {
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Apps & permissions/ })).toBeInTheDocument();
    await page.getByRole('tab', { name: /Apps & permissions/ }).click();
    expect(router.replace).toHaveBeenCalledTimes(1);
    const [url, as, opts] = vi.mocked(router.replace).mock.calls[0] as unknown as [
      { pathname: string; query: Record<string, unknown> },
      undefined,
      { shallow?: boolean }
    ];
    expect(url.pathname).toBe('/apps/activity');
    expect(url.query).toEqual({ tab: 'permissions' });
    expect(as).toBeUndefined();
    // `shallow` is what keeps a tab click from re-running `getServerSideProps`.
    expect(opts?.shallow).toBe(true);
  });

  test('…and switching BACK to the default drops the key rather than writing it', async () => {
    router.query = { tab: 'permissions' };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    await page.getByRole('tab', { name: /Recent activity/ }).click();
    const [url] = vi.mocked(router.replace).mock.calls[0] as unknown as [
      { query: Record<string, unknown> }
    ];
    expect(url.query).toEqual({});
  });
});

describe('🔴 the INSTALL-ONLY tabs are gated on the SLOT flag', () => {
  test('present for a viewer WITH appBlocks', async () => {
    mocks.flags = { appBlocks: true, appBlocksPages: false, appListings: true };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    expect(pageTab('Installs'), 'a slot-flag viewer must get the Installs tab').toBeDefined();
    expect(pageTab('Hidden'), 'a slot-flag viewer must get the Hidden tab').toBeDefined();
  });

  test('🔴 ABSENT for a viewer with appBlocksPages but NOT appBlocks', async () => {
    // The cohort criterion 2 widened the page for. They have activity and no slot
    // install, so those tabs' own content — subscriptions, per-model installs, and the
    // per-model installs they have HIDDEN — is exactly what they cannot have.
    mocks.flags = { appBlocks: false, appBlocksPages: true, appListings: true };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByText(/Recent actions apps have taken/)).toBeInTheDocument();
    expect(
      pageTab('Installs'),
      'the Installs tab must be hidden without appBlocks'
    ).toBeUndefined();
    expect(pageTab('Hidden'), 'the Hidden tab must be hidden without appBlocks').toBeUndefined();
    // 🔴 `Apps & permissions` IS GATED TOO, and its DATA SOURCE is the reason. The panel's
    // only read is `blocks.listMyScopeGrants`, whose `enforceAppBlocksFlag` middleware
    // returns `[]` for exactly this viewer — so ungated the tab showed them its installs
    // empty state, always. There was no cohort for whom it held content. (An earlier
    // revision of this file argued the opposite; that premise was false at the data layer
    // and is retracted.)
    expect(
      pageTab('Apps & permissions'),
      'the permissions tab must be hidden without appBlocks — its own query refuses'
    ).toBeUndefined();
    // 🔴 THE WHOLE LIST, NOT JUST THE ABSENCES — pinned as an exact ledger so that
    // gating or un-gating a tab cannot slip through green. It is EMPTY rather than
    // one-long because exactly ONE tab survives the gates and the bar then collapses
    // (see the `< 2` test below); the panel itself still renders, which is what the
    // `expect.element` above asserts.
    expect(pageTabs().map((el) => el.textContent?.trim())).toEqual([]);
  });

  test('🔴 a stale `?tab=hidden` link renders a PAGE, not an empty bar', async () => {
    // THE SYMPTOM the resolver fix exists to prevent, asserted where it is actually
    // felt. `?tab=hidden` is a link this viewer can legitimately hold — a teammate's
    // share, a bookmark from before a flag moved, their own history. Before the
    // resolver widened, `hidden` was handed to `Tabs.value` while no such tab was
    // rendered, and Mantine drew a bar with NOTHING selected over an empty panel: a
    // blank page with no error and no console warning.
    mocks.flags = { appBlocks: false, appBlocksPages: true, appListings: true };
    router.query = { tab: 'hidden' };
    renderWithProviders(<AppActivityPage />);
    // 🔴 ASSERTED ON THE PANEL, NOT THE TAB. This viewer's bar now collapses (one visible
    // tab), so there is no `role="tab"` to select — the symptom this guards against is
    // "a blank page", and the panel's own copy is what proves a page rendered. Falling
    // back is still what puts `activity` in `Tabs.value`; if the resolver handed Mantine
    // the unrendered `hidden`, no panel would render and this element would be absent.
    await expect.element(page.getByText(/Recent actions apps have taken/)).toBeInTheDocument();
  });

  test('🔴 …and the SAME link still selects Hidden for a viewer who HAS the flag', async () => {
    // NEGATIVE CONTROL for the fallback above: without it, a page that ignored `?tab=`
    // entirely, or one that hard-coded the default, would pass that test.
    mocks.flags = { appBlocks: true, appBlocksPages: true, appListings: true };
    router.query = { tab: 'hidden' };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    expect(selectedPageTab()?.textContent?.trim()).toBe('Hidden');
  });

  test('🔴 the bar COLLAPSES at one visible tab, mirroring `AppsSubNav`', async () => {
    // `AppsSubNav` hides its bar below two rows (`links.length < 2`). This bar now does
    // the same, and the branch is REACHABLE: with `permissions` gated on the slot flag,
    // the slotless viewer is left with `activity` alone, and a one-tab bar is chrome
    // offering no choice. `appsActivityTabs.test.ts` holds the unit-tier tripwire that
    // `visibleActivityTabs(SLOTLESS).length === 1`.
    mocks.flags = { appBlocks: false, appBlocksPages: true, appListings: true };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByText(/Recent actions apps have taken/)).toBeInTheDocument();
    expect(pageTabs().length, 'a one-tab bar must not render at all').toBe(0);
  });

  test('🔴 POSITIVE CONTROL: the bar DOES render above the threshold', async () => {
    // Without this, the collapse above is satisfied by a page that never renders a bar.
    // Same component, one flag flipped: four tabs survive, so the list is present.
    mocks.flags = { appBlocks: true, appBlocksPages: true, appListings: true };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    expect(pageTabs().map((el) => el.textContent?.trim())).toEqual([
      'Recent activity',
      'Installs',
      'Apps & permissions',
      'Hidden',
    ]);
  });

  test('🔴 …and the page still LOADS for the slotless viewer (criterion 2, client half)', async () => {
    // The page body re-checks the gate with `canAccessAppsActivity`. If that had stayed
    // on `appBlocks` alone this would render `<NotFound />` and no content at all — which
    // is what makes the collapse test above non-vacuous rather than a test of a 404.
    // Asserted on the PANEL, since this viewer's bar is collapsed by design.
    mocks.flags = { appBlocks: false, appBlocksPages: true, appListings: true };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByText(/Recent actions apps have taken/)).toBeInTheDocument();
    expect(document.querySelector('[data-testid="mock-notfound"]')).toBeNull();
  });

  test('🔴 NEGATIVE CONTROL: NEITHER runtime flag renders no tabs at all', async () => {
    // Guards the cases above against a body that renders the page unconditionally.
    // 🔴 LOAD-BEARING NOW THAT THE BAR COLLAPSES: "zero tabs" is no longer a signature
    // unique to the 404, so this arm asserts the 404 MARKER, and the case above asserts
    // the marker's ABSENCE. Neither is inferable from the tab count any more.
    mocks.flags = { appBlocks: false, appBlocksPages: false, appListings: true };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByTestId('mock-notfound')).toBeInTheDocument();
    expect(pageTabs()).toHaveLength(0);
  });
});

describe('🔴 the header marketplace CTA is gone; the empty-state anchors remain', () => {
  test('the activity tab offers exactly ONE way to /apps — the empty state, not a header button', async () => {
    // 🔴 STRUCTURAL, NOT COPY-MATCHED. `origin/main` rendered TWO `/apps` anchors in the
    // page body on this tab: the `AppsPageLayout` `actions` button AND `EmptyActivity`'s
    // anchor. One survives. Counting them is what makes this fail if the button comes
    // back under different words.
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    // TWO, not one: Mantine's `Tabs.Panel` is `keepMounted` by default, so every panel's
    // children are in the DOM regardless of which tab is selected. That is what makes ONE
    // assertion cover both surviving empty states — `EmptyActivity` and the Installs
    // `EmptyState`.
    //
    // 🔴 TWO RATHER THAN THREE BECAUSE THE FIXTURE STOPPED LYING. This arm holds
    // `appBlocks: true`, so `blocks.listMyScopeGrants` now returns a GRANT (mirroring the
    // real procedure, which only short-circuits to `[]` without that flag) and the
    // permissions panel renders its grid instead of an empty state. When the fixture
    // hard-coded `[]` in every arm, that third anchor was an artefact of the fixture, not
    // of the page.
    expect(
      bodyMarketplaceLinks().map((el) => el.textContent?.trim()),
      'the header CTA is back, or an empty-state anchor is gone'
    ).toEqual(['Browse the marketplace', 'Browse the marketplace']);
    // …and the permissions panel really did render CONTENT rather than an empty state —
    // the positive control that makes the count above a fact about the flag.
    expect(page.getByText('Demo App').elements().length).toBeGreaterThan(0);
  });

  /**
   * 🔴 …AND THOSE ANCHORS ARE THEMSELVES STORE-GATED, which is a gap THIS PR OPENED.
   *
   * `/apps` SSR-gates on `resolveAppsPageAccess` → `hasAppsStoreAccess` =
   * `appListings || appBlocks || appListingsPublicExternal`. `appBlocksPages` is NOT one
   * of those three. So the moment this page widened to `appBlocks || appBlocksPages`, a
   * viewer holding `appBlocksPages` ALONE could load it and be handed a marketplace link
   * that answers `notFound` — the #3899 / #4668 defect class (an affordance into a 404),
   * introduced by the widening rather than by a drifted rule.
   *
   * ── THE MUTATION CHECK ───────────────────────────────────────────────────────
   * Delete the `canSeeStore &&` guard from `EmptyState` in `pages/apps/activity.tsx` and
   * the first test below fails on its OWN assertion — the anchor list it requires to be
   * empty comes back non-empty. The two tests above (which run with `appListings: true`)
   * stay green under that mutant, so the red is attributable to the gate.
   */
  test('🔴 a page-apps-only viewer gets NO marketplace anchor anywhere on the page', async () => {
    // The exact cohort criterion 2 admitted: the PAGE gate passes on `appBlocksPages`,
    // the STORE gate passes on nothing.
    mocks.flags = { appBlocks: false, appBlocksPages: true, appListings: false };
    renderWithProviders(<AppActivityPage />);
    // The bar is collapsed for this viewer (one visible tab), so wait on the PANEL.
    await expect.element(page.getByText(/Recent actions apps have taken/)).toBeInTheDocument();
    expect(
      bodyMarketplaceLinks().map((el) => el.textContent?.trim()),
      'a link into a `notFound` was offered to a viewer with no store access'
    ).toEqual([]);
    // …and the page itself still rendered, so the empty anchor list is not the empty list
    // of a 404. Exactly ONE empty state mounts for this viewer — `EmptyActivity`; the
    // Installs, permissions and Hidden panels are all slot-flag-gated away.
    expect(page.getByText(/No activity yet/).elements().length).toBeGreaterThan(0);
  });

  test('POSITIVE CONTROL: adding the STORE flag alone brings the anchors back', async () => {
    // Same runtime flags, one store flag added. Without this the assertion above would
    // also be satisfied by empty states that lost their CTA for everyone.
    mocks.flags = { appBlocks: false, appBlocksPages: true, appListings: true };
    renderWithProviders(<AppActivityPage />);
    // Bar collapsed for this viewer — wait on the panel.
    await expect.element(page.getByText(/Recent actions apps have taken/)).toBeInTheDocument();
    expect(bodyMarketplaceLinks().length).toBeGreaterThan(0);
  });

  test('🔴 NEGATIVE CONTROL: the count is not trivially "whatever renders"', async () => {
    // At `origin/main` this same query returns FOUR anchors — three empty states plus the
    // `AppsPageLayout` `actions` button, whose text is `Browse marketplace` (no "the").
    // So the assertion above is red there on both the length AND the extra member, and
    // neither half is a copy match against a string this test invented.
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    expect(bodyMarketplaceLinks().length).toBeGreaterThan(0);
    expect(
      bodyMarketplaceLinks().some((el) => el.textContent?.trim() === 'Browse marketplace'),
      'the removed header CTA is back'
    ).toBe(false);
  });
});

/**
 * The per-app daily Buzz limit on the Permissions panel.
 *
 * 🔴 WHY THIS SUITE EXISTS. Before it, `buzzBudgetPerDay` was returned by the API and
 * read by NO component: the consent modal is the only writer and it only offers the
 * field while `ai:write:budgeted` is still MISSING, which is true exactly once per app,
 * forever. A user could therefore set a limit and then had no way to see it, raise it,
 * lower it or clear it — and the floor is 1, so a too-low value refused every generation
 * with no path back through the product. `recordScopeGrant`'s documented null-clears
 * branch had ZERO callers.
 *
 * ── RED BEFORE THIS CHANGE ────────────────────────────────────────────────────
 * Every test below fails against the previous revision of `pages/apps/activity.tsx` for
 * the reason it names: there is no `app-budget-row`, no `app-budget-edit`, and no
 * mutation to observe.
 */
describe('Apps & permissions — the per-app daily Buzz limit', () => {
  beforeEach(() => {
    mocks.mutate.mockClear();
    // Select the Permissions tab. Mantine keeps every panel MOUNTED but the unselected
    // ones are not VISIBLE, and a browser-mode `click`/`fill` waits for visibility — so
    // without this the interaction tests hang to timeout and read as a broken control.
    router.query = { tab: 'permissions' };
  });

  test('renders the stored limit for an app the viewer granted the spend scope', async () => {
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByTestId('app-budget-value')).toBeInTheDocument();
    // The whole line, not a keyword: "750" alone would pass on copy that said the
    // opposite of what the number means.
    await expect
      .element(page.getByTestId('app-budget-value'))
      .toHaveTextContent('Daily Buzz limit: 750 Buzz/day');
  });

  // 🔴 THE DISCRIMINATING HALF. The fixture holds THREE apps and only one has the spend
  // scope GRANTED, so exactly one control may render. Without this, a control rendered
  // unconditionally would pass the test above.
  // (⚠️ Said TWO until the grant-only fixture was added below and this count was left
  // behind — a claim staled by the same commit that added the third card.)
  test('renders NO limit control for an app without the granted spend scope', async () => {
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByTestId('apps-installed-grants-grid')).toBeInTheDocument();
    // Positive control: ALL THREE apps really rendered, so "one control" is a fact about
    // the grant and not about a panel that only drew one card.
    expect(page.getByTestId('app-budget-value').elements()).toHaveLength(1);
    const names = Array.from(
      document.querySelectorAll('[data-testid="apps-installed-grants-grid"] .truncate')
    ).map((el) => el.textContent?.trim());
    expect(names).toContain('Demo App');
    expect(names).toContain('Spender');
    // 🔴 THE GRANT-ONLY CARD RENDERS AT ALL. Before `listMyScopeGrants` enumerated
    // `app_user_scope_grants`, a row with no install and no subscription could not exist,
    // so nothing at this tier ever drew this card — and by the production counts it is the
    // dominant population. Asserting it here is what makes the two length checks below
    // "one control across THREE cards" rather than "one control across the two that
    // happened to render".
    expect(names).toContain('Consented Only');
    // Its surface line names the provenance it actually came from. Pinned as the whole
    // string: a keyword match would pass on the previous text ("Subscriptions: none"),
    // which on a consent surface reads as a claim that the app has no access.
    expect(
      Array.from(document.querySelectorAll('[data-testid="apps-installed-grants-grid"]')).some(
        (el) => el.textContent?.includes('Granted at consent · no install or subscription')
      ),
      'the grant-only card must name its provenance, not report "Subscriptions: none"'
    ).toBe(true);
    expect(page.getByTestId('app-budget-row').elements()).toHaveLength(1);
  });

  test('Save sends the new limit for THAT app, and widens no scope', async () => {
    renderWithProviders(<AppActivityPage />);
    await page.getByTestId('app-budget-edit').click();
    const input = page.getByTestId('app-budget-input');
    await input.clear();
    await input.fill('2500');
    await page.getByTestId('app-budget-save').click();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    // 🔴 `scopes` IS THE SPEND SCOPE ALONE. `grantScopes` is ADDITIVE, so sending the
    // app's manifest scopes here would GRANT every scope it declares — a silent widening
    // performed by a control that says "limit". Re-sending the one scope the user has
    // already granted unions with itself and cannot change the stored set.
    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      appBlockId: 'apb_spend',
      scopes: ['ai:write:budgeted'],
      buzzBudgetPerDay: 2500,
    });
  });

  test('Remove limit sends an EXPLICIT null (the clear branch), not an omitted key', async () => {
    renderWithProviders(<AppActivityPage />);
    await page.getByTestId('app-budget-edit').click();
    await page.getByTestId('app-budget-clear').click();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const payload = mocks.mutate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toEqual({
      appBlockId: 'apb_spend',
      scopes: ['ai:write:budgeted'],
      buzzBudgetPerDay: null,
    });
    // The SERVER distinguishes an omitted key (leave the stored value alone) from an
    // explicit null (clear it) via an `in` test, and `toEqual` above would also accept
    // an absent key. This is the half that pins the clear.
    expect(Object.hasOwn(payload, 'buzzBudgetPerDay')).toBe(true);
    expect(payload.buzzBudgetPerDay).toBeNull();
  });

  test('an out-of-range value disables Save rather than sending one the server refuses', async () => {
    renderWithProviders(<AppActivityPage />);
    await page.getByTestId('app-budget-edit').click();
    const input = page.getByTestId('app-budget-input');
    await input.clear();
    await input.fill('999999');
    await expect.element(page.getByTestId('app-budget-save')).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test('warns when the entered limit is too low to fund a generation', async () => {
    renderWithProviders(<AppActivityPage />);
    await page.getByTestId('app-budget-edit').click();
    // 750 (the stored value the editor opens on) is fundable → no warning.
    expect(page.getByTestId('app-budget-low-warning').elements()).toHaveLength(0);
    const input = page.getByTestId('app-budget-input');
    await input.clear();
    await input.fill('5');
    await expect.element(page.getByTestId('app-budget-low-warning')).toBeInTheDocument();
  });
});

/**
 * 🔴 THE PERMISSIONS TAB MUST NOT INSTRUCT AN ACTION THAT DOES NOT DO WHAT IT SAYS.
 *
 * The retracted copy read: "This is a reflection of the current state — to revoke access,
 * remove the install or subscription on the Installs tab." Removing an install does NOT
 * revoke the scope grant. `BlockRegistry.deleteSubscription` deletes the
 * `block_user_subscriptions` row and nothing else; `uninstallFromModel` additionally
 * revokes the block INSTANCE token, which invalidates already-minted tokens but leaves the
 * consent row intact. The grant lives in `app_user_scope_grants`, whose only writes in the
 * entire repo are the two in `~/server/services/blocks/scope-grant.service.ts`, both
 * setting `revokedAt: null`. Nothing writes a non-null `revoked_at`; nothing deletes a row.
 * So the scopes survive the uninstall and the next mint carries them with no fresh prompt.
 *
 * 🔴 PINNED AS THE WHOLE NORMALISED STRING, AND MATCHED **EXACTLY**. The artifact under
 * test is PROSE, so a guard on keywords is walkable by rewording — a future edit could
 * reintroduce "remove the install to revoke" without tripping any `/revoke/`-shaped
 * matcher, because the honest copy contains that word too. Pinning the whole sentence
 * means a cosmetic reword fails this test; that cost is the price of a machine-readable
 * claim about what the page tells users. If you are here because you reworded it, re-read
 * the paragraph above and confirm your new wording is still TRUE before updating it.
 *
 * 🔴 `{ exact: true }` IS LOAD-BEARING, NOT TIDINESS — without it this guard was WALKABLE
 * and the paragraph above was false. `page.getByText(str)` is SUBSTRING matching, so the
 * pin caught a reword (which changes the string) and NOT an append (which leaves it
 * byte-intact). MEASURED at the parent of this commit: appending
 * "To withdraw a permission, remove the install on the Installs tab." to the same `<Text>`
 * left the literal untouched and the whole file passed **26/26** — i.e. the exact
 * instruction this block exists to retract could be put back, as a second sentence, with
 * every test green. With `exact: true` that same append fails 2 of 26 on this locator.
 *
 * 🔴 BUT `exact: true` ALONE CLOSES ONLY THE SAME-ELEMENT APPEND — it is geometry, not
 * string semantics, and an audit walked it: the locator matches the deepest element whose
 * whole normalised subtree text equals the string, so moving the same sentence into a
 * SIBLING `<Text>` in the same `<Stack>` leaves the pinned `<p>` byte-identical and the
 * pin matches again. MEASURED: that sibling walk passed 26/26 with `exact: true` in place.
 * Adding a line of copy as a new `<Text>` is at least as natural as extending an existing
 * one, so this was the likely shape, not an exotic one. What closes it is the PAGE-WIDE
 * absence check in the tripwire below — which is why that assertion is a phrase class
 * rather than a literal, and why it reads `document.body.textContent` rather than this
 * element. The two guards cover different geometry ON PURPOSE: this one pins the exact
 * sentence, that one bans the instruction anywhere on the page.
 *
 * ⚠️ CONTAINMENT NOTE for the tripwire's wait: its anchor comes from the ACTIVITY panel,
 * which is ungated, while the permissions panel is gated on `appBlocks`. So in a state
 * where the permissions panel is absent entirely, the tripwire passes vacuously — the
 * coverage for that state lives in the two tests that DO wait on the copy itself, which
 * fail loudly in the same run. Do not read the tripwire alone as proof the panel exists.
 */
describe('🔴 the revoke instruction is retracted, not reworded', () => {
  // 🔴 WIDENED WITH THE DATA SOURCE, NOT REWORDED FOR STYLE. `listMyScopeGrants` now also
  // enumerates live `app_user_scope_grants` rows, so "installed or subscribed to" described a
  // population narrower than the one the panel below it lists — the same overstatement this
  // block exists to catch, pointing the other way. The whole-string pin is doing exactly its
  // job here: this literal had to move because the claim moved.
  const PERMISSIONS_TAB_COPY =
    "The apps you've installed, subscribed to, or granted permissions to, what each one " +
    'declares it may use, and where you have it. Removing an install on the Installs tab ' +
    'takes the app off that surface, but it does not withdraw a permission you have already ' +
    'granted — withdrawing one is not possible yet. Recent activity is the full record of ' +
    'what apps have actually done on your account.';

  /**
   * A string from the ACTIVITY panel, deliberately not from the copy under test. Used as
   * the render-wait for the absence check below — see the comment there for why the wait
   * and the assertion must not be the same string.
   */
  const ACTIVITY_PANEL_ANCHOR = 'Recent actions apps have taken';

  test('the panel states plainly that withdrawing a permission is not possible', async () => {
    // `Tabs.Panel` is `keepMounted` by default, so the permissions panel's copy is in the
    // DOM without a click — the same property the marketplace-anchor count above relies on.
    mocks.flags = { appBlocks: true, appBlocksPages: true, appListings: true };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByText(PERMISSIONS_TAB_COPY, { exact: true })).toBeInTheDocument();
  });

  test('🔴 …and the retracted sentence is nowhere on the page', async () => {
    // A second, cheaper tripwire aimed at a LITERAL revert (a `git revert`, a bad merge
    // resolution) rather than at a reword — the pin above is what covers rewording. Kept
    // because the two fail with very different messages, and this one names the defect.
    mocks.flags = { appBlocks: true, appBlocksPages: true, appListings: true };
    renderWithProviders(<AppActivityPage />);
    // 🔴 WAIT ON A STABLE ANCHOR, NOT ON THE COPY UNDER TEST — and the distinction is the
    // whole fix here. `renderWithProviders` is async and is not awaited, so an absence
    // check placed first runs against an EMPTY body and passes vacuously. This tripwire
    // previously waited on `PERMISSIONS_TAB_COPY` itself, which supplied the await but made
    // the check unreachable in the one scenario it names: on a literal revert that copy is
    // gone, so the wait failed first and this assertion never ran — measured, all three
    // tests died with the same locator error and this message never appeared. Reordering
    // alone does NOT fix it; it just trades unreachable for vacuous (also measured).
    //
    // So: wait on a string from a DIFFERENT panel, which survives any rewrite of the copy
    // under test. That proves the page rendered without coupling the wait to the thing
    // being asserted about.
    await expect.element(page.getByText(ACTIVITY_PANEL_ANCHOR)).toBeInTheDocument();
    // 🔴 A PHRASE CLASS, NOT A LITERAL — and for an ABSENCE check that is the STRONGER
    // choice, which is the exact inverse of the presence pin above. There, prose is
    // walkable by rewording, so the whole string is pinned. Here, rewording IS the attack:
    // a literal `toContain('to revoke access, remove the install')` is walked by
    // "remove your install", "to withdraw a permission, remove the install", or any other
    // spelling of the same false instruction.
    //
    // 🔴 PURPOSIVE, NOT MERELY CO-OCCURRING, because the honest copy legitimately mentions
    // BOTH halves in one sentence in order to CONTRAST them ("Removing an install … does
    // not withdraw a permission"). MEASURED against a looser co-occurrence pattern: it
    // false-positives on an imperative rewrite of the HONEST copy ("Remove an install …
    // but it does not withdraw a permission"). Requiring the infinitive-of-purpose
    // ("to revoke/withdraw … remove … install", or the reverse order) rejects all three
    // honest variants tried and catches all four dishonest ones.
    const REVOKE_BY_UNINSTALL =
      /\bto\s+(revoke|withdraw)\b[\s\S]{0,60}\bremov\w*\b[\s\S]{0,25}\binstall|\bremov\w*\b[\s\S]{0,25}\binstall[\s\S]{0,60}\bto\s+(revoke|withdraw)\b/i;
    expect(
      document.body.textContent ?? '',
      'the copy instructs an uninstall as a way to revoke access, which it is not'
    ).not.toMatch(REVOKE_BY_UNINSTALL);
  });

  test('🔴 POSITIVE CONTROL: the body text really is readable from here', async () => {
    // Without this, the `not.toContain` above passes for a page that rendered nothing at
    // all — the reassuring-zero shape. Assert a string the page MUST carry, taken from a
    // different panel so it cannot be satisfied by the copy under test.
    mocks.flags = { appBlocks: true, appBlocksPages: true, appListings: true };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByText(PERMISSIONS_TAB_COPY, { exact: true })).toBeInTheDocument();
    expect(document.body.textContent ?? '').toContain(ACTIVITY_PANEL_ANCHOR);
  });
});
