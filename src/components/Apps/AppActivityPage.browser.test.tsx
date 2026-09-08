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
  /** The reads whose CONTENT this file depends on — everything else is inert. */
  const DATA: Record<string, unknown> = {
    // EMPTY on purpose: the empty states are where the three surviving marketplace
    // anchors live, and their presence is one of the criteria under test.
    'blocks.listMySubscriptions': [],
    'blocks.listMyScopeGrants': [],
    'blocks.listMyAppActivity': { pages: [{ items: [], nextCursor: null }] },
    'blocks.listMyScopeInvocations': { pages: [{ items: [], nextCursor: null }] },
    'blocks.getNavSummary': {
      hasInstalls: true,
      hasSubmissions: false,
      hasApprovedApps: false,
      isReviewer: false,
      hasEditableApps: false,
      hasPendingInvites: false,
    },
  };
  const node = (data?: unknown): unknown =>
    new Proxy(
      {},
      {
        get(_t, key: string) {
          if (key === 'useQuery' || key === 'useInfiniteQuery') {
            return () => (data === undefined ? inert : { ...inert, data });
          }
          if (key === 'useMutation') return () => inert;
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

describe('🔴 the Installs tab is gated on the SLOT flag', () => {
  test('present for a viewer WITH appBlocks', async () => {
    mocks.flags = { appBlocks: true, appBlocksPages: false, appListings: true };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    expect(pageTab('Installs'), 'a slot-flag viewer must get the Installs tab').toBeDefined();
  });

  test('🔴 ABSENT for a viewer with appBlocksPages but NOT appBlocks', async () => {
    // The cohort criterion 2 widened the page for. They have activity and no slot
    // install, so the tab's own content — subscriptions and per-model installs — is
    // exactly what they cannot have.
    mocks.flags = { appBlocks: false, appBlocksPages: true, appListings: true };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    expect(
      pageTab('Installs'),
      'the Installs tab must be hidden without appBlocks'
    ).toBeUndefined();
    // …and the page is still a page: the other three tabs render.
    expect(pageTabs().map((el) => el.textContent?.trim())).toEqual([
      'Recent activity',
      'Apps & permissions',
      'Hidden',
    ]);
  });

  test('🔴 …and the page still LOADS for that viewer (criterion 2, client half)', async () => {
    // The page body re-checks the gate with `canAccessAppsActivity`. If that had stayed
    // on `appBlocks` alone this would render `<NotFound />` and no tabs at all — which is
    // what makes the tab test above non-vacuous rather than a test of a 404.
    mocks.flags = { appBlocks: false, appBlocksPages: true, appListings: true };
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    expect(pageTabs().length).toBeGreaterThan(0);
  });

  test('🔴 NEGATIVE CONTROL: NEITHER runtime flag renders no tabs at all', async () => {
    // Guards the three cases above against a body that renders the page unconditionally.
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
    // THREE, not one: Mantine's `Tabs.Panel` is `keepMounted` by default, so every
    // panel's children are in the DOM regardless of which tab is selected. That is what
    // makes ONE assertion cover all three empty states — `EmptyActivity`, the Installs
    // `EmptyState` and the permissions `EmptyState`.
    expect(
      bodyMarketplaceLinks().map((el) => el.textContent?.trim()),
      'the header CTA is back, or an empty-state anchor is gone'
    ).toEqual(['Browse the marketplace', 'Browse the marketplace', 'Browse the marketplace']);
  });

  test('🔴 NEGATIVE CONTROL: the count is not trivially "whatever renders"', async () => {
    // At `origin/main` this same query returns FOUR anchors — the three empty states plus
    // the `AppsPageLayout` `actions` button, whose text is `Browse marketplace` (no
    // "the"). So the assertion above is red there on both the length AND the extra
    // member, and neither half is a copy match against a string this test invented.
    renderWithProviders(<AppActivityPage />);
    await expect.element(page.getByRole('tab', { name: /Recent activity/ })).toBeInTheDocument();
    expect(bodyMarketplaceLinks().length).toBeGreaterThan(0);
    expect(
      bodyMarketplaceLinks().some((el) => el.textContent?.trim() === 'Browse marketplace'),
      'the removed header CTA is back'
    ).toBe(false);
  });
});
