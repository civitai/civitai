import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useRouter } from 'next/router';
// Type-only: gives the `importOriginal` spread below the real module's type
// without an `import()` type annotation (banned by consistent-type-imports).
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * Item 2 — the UNIFIED tabbed owner editor page `/apps/[appBlockId]/edit`. Browser-
 * mode render test (report-only; the sandbox has no chromium binary). Verifies the
 * two tabs render, `?tab=media` selects the media tab, and a non-owner (getMyAppManifest
 * errors) settles to NotFound. The heavy children + SSR helper are mocked so the page's
 * OWN tab/gating logic is what's under test.
 */

const mocks = vi.hoisted(() => ({
  manifestQuery: {
    data: {
      appBlockId: 'blk-1',
      slug: 'my-app',
      version: '1.0.0',
      manifest: { name: 'My App' },
    } as unknown,
    isLoading: false,
    error: null as unknown,
  },
}));

// The page statically imports createServerSideProps — stub it so importing the page
// module doesn't pull the server SSR graph into the browser bundle.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

// 🔴 `appBlocksAuthor` IS LOAD-BEARING NOW, not decoration. This page moved onto the
// shared `AppsPageLayout`, which mounts `AppsSubNav` — and that bar hides itself below
// TWO qualifying tabs. Without the author capability the viewer qualifies for
// Marketplace alone, the bar renders nothing, and the chrome assertion below would
// pass or fail for a reason that has nothing to do with this page.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
}));

// The sub-nav's other two inputs. `useCurrentUser` is mocked rather than provided
// because the real hook throws `missing CivitaiSessionContext` under this scaffold —
// the same reason `AppsPageLayout`'s own browser tests mock it.
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'owner', isModerator: false }),
}));

// NOTE: this file used to carry its own `vi.mock('next/router', ...)`. It SILENTLY LOST to
// the scaffold's mock in `test/component-setup.tsx` (a setup-file mock the per-file one does
// not override here), so `router.query` was always `{}` — `?tab=media` could never select the
// media tab. Use the scaffold's SHARED router object and seed `query` per test instead, which
// is the established idiom (see `src/tests/pages/payment/success.browser.test.tsx`).
const router = useRouter();

// Only the `trpc` client itself is overridden — every other `~/utils/trpc` export
// (trpcVanilla, queryClient, setTrpcBatchingEnabled, ...) is kept real via
// importOriginal. A wholesale factory silently breaks this whole FILE (0 tests
// collected, no failing assertion) the day the module gains an export some other
// file in this test's graph imports. See local-rules/no-wholesale-module-mock.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    blocks: {
      getMyAppManifest: {
        useQuery: () => mocks.manifestQuery,
      },
      // Mounted by `AppsSubNav` via the shared page layout this page now uses.
      // Undefined data ⇒ the deterministic always-on tab set.
      getNavSummary: { useQuery: () => ({ data: undefined }) },
    },
    useUtils: () => ({}),
  },
}));

// Mock the heavy children to simple markers — the page's tab wiring is what matters.
vi.mock('~/components/Apps/ManifestEditForm', () => ({
  ManifestEditForm: () => <div data-testid="mock-manifest-form">manifest form</div>,
}));
vi.mock('~/components/Apps/ListingMediaEditor', () => ({
  ListingMediaEditor: ({ appBlockId }: { appBlockId: string }) => (
    <div data-testid="mock-media-editor">media editor for {appBlockId}</div>
  ),
}));
vi.mock('~/components/AppLayout/NotFound', () => ({
  NotFound: () => <div data-testid="mock-notfound">not found</div>,
}));
// The page renders `<Meta>`, which calls `useBrowserRouter()` — that hook THROWS
// ("missing context") without a BrowserRouterProvider, which `renderWithProviders`
// deliberately doesn't mount. Unmocked it takes the whole page render down (empty
// <body>), so every assertion here fails by burning its 5s timeout. Same stub the
// review-queue-nav page test uses.
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));

const AppEditPage = (await import('../../pages/apps/[appBlockId]/edit')).default;

beforeEach(() => {
  mocks.manifestQuery.error = null;
  mocks.manifestQuery.isLoading = false;
  router.query = { appBlockId: 'blk-1' };
});

describe('AppEditPage (/apps/[appBlockId]/edit)', () => {
  test('renders BOTH tabs and defaults to the manifest tab', async () => {
    renderWithProviders(<AppEditPage />);
    await expect.element(page.getByTestId('apps-edit-tab-manifest')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-edit-tab-media')).toBeInTheDocument();
    // Default tab = manifest → the manifest form renders.
    await expect.element(page.getByTestId('mock-manifest-form')).toBeInTheDocument();
    // A history-aware Back control is present.
    await expect.element(page.getByTestId('apps-edit-back')).toBeInTheDocument();
  });

  test('?tab=media selects the media tab (renders the media editor)', async () => {
    router.query = { appBlockId: 'blk-1', tab: 'media' };
    renderWithProviders(<AppEditPage />);
    await expect.element(page.getByTestId('mock-media-editor')).toBeInTheDocument();
    await expect.element(page.getByText(/media editor for blk-1/i)).toBeInTheDocument();
  });

  test('a non-owner (getMyAppManifest errors) settles to NotFound', async () => {
    mocks.manifestQuery.error = { message: 'FORBIDDEN' };
    renderWithProviders(<AppEditPage />);
    await expect.element(page.getByTestId('mock-notfound')).toBeInTheDocument();
  });

  test('🔴 the page is on the SHARED apps chrome, not its own bare Container', async () => {
    // Regression coverage for the adoption: this page rendered a standalone
    // `<Container>` and showed NO sub-nav at all, so `/apps/<id>/edit` was one of
    // four `/apps/*` routes where the navigation simply vanished. The landmark is
    // what `AppsPageLayout` contributes, so its presence is the adoption.
    renderWithProviders(<AppEditPage />);
    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
  });

  test('…and the chrome does not displace the page body', async () => {
    // Guard-the-guard for the test above: a landmark that rendered INSTEAD of the
    // page would satisfy it. Both must be present in the same render.
    renderWithProviders(<AppEditPage />);
    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    await expect.element(page.getByTestId('apps-edit-tab-manifest')).toBeInTheDocument();
    await expect.element(page.getByTestId('mock-manifest-form')).toBeInTheDocument();
  });
});
