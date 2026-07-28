import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
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
  routerQuery: { appBlockId: 'blk-1', tab: undefined as string | undefined },
}));

// The page statically imports createServerSideProps — stub it so importing the page
// module doesn't pull the server SSR graph into the browser bundle.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));

vi.mock('next/router', () => ({
  useRouter: () => ({
    query: mocks.routerQuery,
    replace: vi.fn(),
    push: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      getMyAppManifest: {
        useQuery: () => mocks.manifestQuery,
      },
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

const AppEditPage = (await import('../../pages/apps/[appBlockId]/edit')).default;

beforeEach(() => {
  mocks.manifestQuery.error = null;
  mocks.manifestQuery.isLoading = false;
  mocks.routerQuery = { appBlockId: 'blk-1', tab: undefined };
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
    mocks.routerQuery = { appBlockId: 'blk-1', tab: 'media' };
    renderWithProviders(<AppEditPage />);
    await expect.element(page.getByTestId('mock-media-editor')).toBeInTheDocument();
    await expect.element(page.getByText(/media editor for blk-1/i)).toBeInTheDocument();
  });

  test('a non-owner (getMyAppManifest errors) settles to NotFound', async () => {
    mocks.manifestQuery.error = { message: 'FORBIDDEN' };
    renderWithProviders(<AppEditPage />);
    await expect.element(page.getByTestId('mock-notfound')).toBeInTheDocument();
  });
});
