import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * edit-manifest page — browser-mode render test (report-only in Tekton).
 *
 * Pins the Change-3 wiring: the page renders the reusable ListingAssetStep for
 * the appListingId resolved by getMyAppManifest, and makes clear the images save
 * immediately (independent of the manifest re-review). ListingAssetStep +
 * ManifestEditForm are stubbed (their internals have their own tests); this test
 * only asserts the PAGE passes the resolved listing id through.
 */

const mocks = vi.hoisted(() => ({
  listingAssetStep: vi.fn((props: { listingId: string }) => props),
}));

// Server-only module pulled in by the page's getServerSideProps — stub so the
// page module imports cleanly in the browser test env.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

vi.mock('~/server/schema/blocks/offsite-listing.schema', () => ({
  OFFSITE_CONTENT_RATINGS: ['g', 'pg', 'pg13', 'r', 'x'],
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));

vi.mock('next/router', () => ({
  useRouter: () => ({ query: { appBlockId: 'app-1' } }),
}));

// Stub the heavy children so we only test the page wiring.
vi.mock('~/components/Apps/ManifestEditForm', () => ({
  ManifestEditForm: () => <div data-testid="manifest-edit-form-stub" />,
}));

vi.mock('~/components/Apps/ListingAssetStep', () => ({
  ListingAssetStep: (props: { listingId: string; contentRating: string }) => {
    mocks.listingAssetStep(props);
    return <div data-testid="listing-asset-step-stub" data-listing-id={props.listingId} />;
  },
}));

const manifestQuery = vi.hoisted(() => ({
  data: {
    appBlockId: 'app-1',
    slug: 'my-block',
    status: 'approved',
    version: '1.0.0',
    manifest: { blockId: 'my-block', scopes: [] },
    allowedScopes: 0,
    allowedOrigins: [] as string[],
    appListingId: 'apl_123' as string | null,
    listingContentRating: 'pg' as string | null,
  },
  isLoading: false,
  error: null as unknown,
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      getMyAppManifest: {
        useQuery: () => manifestQuery,
      },
    },
  },
}));

const EditManifestPage = (await import('~/pages/apps/[appBlockId]/edit-manifest')).default;

describe('EditManifestPage — listing images section', () => {
  test('renders ListingAssetStep for the resolved appListingId (immediately-saved, separate from manifest)', async () => {
    renderWithProviders(<EditManifestPage />);
    await expect.element(page.getByTestId('listing-images-section')).toBeInTheDocument();
    await expect.element(page.getByTestId('listing-asset-step-stub')).toBeInTheDocument();
    // The resolved listing id is passed through.
    expect(mocks.listingAssetStep).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: 'apl_123', contentRating: 'pg' })
    );
    // The separation-from-review copy is present.
    await expect.element(page.getByText(/save/i)).toBeInTheDocument();
  });
});
