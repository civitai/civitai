import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { useRouter } from 'next/router';

/**
 * On-site listing-media OWNER page (`/apps/<appBlockId>/listing`) — route-shell
 * render test (browser mode, report-only in Tekton).
 *
 * Asserts the client wiring: it resolves `appBlockId` → `appListingId`
 * (`getMyListingForApp`), begins the editable shadow revision
 * (`beginListingRevision`), re-hosts the reused `ListingAssetStep` against the
 * SHADOW id + the listing's content rating, surfaces the honest live-app framing
 * copy (+ the pending-revision notice when applicable), and fires
 * `submitListingRevision({ shadowId })` from the Submit-for-review button. The
 * asset step itself is stubbed — its real behaviour is covered by
 * `ListingAssetStep.browser.test.tsx`.
 */

const state = vi.hoisted(() => ({
  // getMyListingForApp.useQuery control object.
  query: {
    data: undefined as unknown,
    isLoading: false,
    error: null as unknown,
  },
  // beginListingRevision — resolves to a shadow id via onSuccess.
  begin: { shadowId: 'apl_shadow' as string | null, error: null as string | null, pending: false },
  // submitListingRevision — captured args.
  submit: { calls: [] as unknown[], pending: false },
  // Props the stubbed ListingAssetStep received.
  assetProps: { last: null as null | { listingId: string; contentRating: string } },
  invalidate: vi.fn().mockResolvedValue(undefined),
  flags: { appBlocks: true } as Record<string, boolean>,
}));

// The page's `getServerSideProps` calls createServerSideProps at module top — stub
// it so importing the page in a browser test doesn't pull the server graph.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => state.flags,
}));

vi.mock('~/components/AppLayout/NotFound', () => ({
  NotFound: () => <div data-testid="not-found">Not found</div>,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

// Stub the reused asset step — capture the props to prove the shell threads the
// SHADOW id + rating, without re-running its own (covered) upload behaviour.
vi.mock('~/components/Apps/ListingAssetStep', () => ({
  ListingAssetStep: (props: { listingId: string; contentRating: string }) => {
    state.assetProps.last = props;
    return (
      <div data-testid="asset-step">
        assets:{props.listingId}:{props.contentRating}
      </div>
    );
  },
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({
      appListings: { getMyListingForApp: { invalidate: state.invalidate } },
    }),
    appListings: {
      getMyListingForApp: { useQuery: () => state.query },
      beginListingRevision: {
        useMutation: () => ({
          mutate: (
            _vars: unknown,
            opts?: { onSuccess?: (r: { shadowId: string }) => void; onError?: (e: { message: string }) => void }
          ) => {
            if (state.begin.error) opts?.onError?.({ message: state.begin.error });
            else if (state.begin.shadowId) opts?.onSuccess?.({ shadowId: state.begin.shadowId });
          },
          isPending: state.begin.pending,
        }),
      },
      submitListingRevision: {
        useMutation: () => ({
          mutateAsync: async (vars: unknown) => {
            state.submit.calls.push(vars);
            return { publishRequestId: 'alpr_1', shadowId: state.begin.shadowId, slug: 'my-app' };
          },
          isPending: state.submit.pending,
        }),
      },
    },
  },
}));

const ListingMediaPage = (await import('~/pages/apps/[appBlockId]/listing')).default;

function setRouterQuery(query: Record<string, string>) {
  const router = (useRouter as unknown as () => { query: Record<string, string> })();
  router.query = query;
}

beforeEach(() => {
  state.query = {
    data: { appListingId: 'apl_onsite', status: 'approved', contentRating: 'pg13', hasPendingRevision: false },
    isLoading: false,
    error: null,
  };
  state.begin = { shadowId: 'apl_shadow', error: null, pending: false };
  state.submit = { calls: [], pending: false };
  state.assetProps.last = null;
  state.invalidate.mockClear();
  state.flags = { appBlocks: true };
  setRouterQuery({ appBlockId: 'my-block' });
});

describe('ListingMediaPage — owner listing-media route shell', () => {
  test('resolves the listing, begins the shadow revision, and renders the asset step against the SHADOW id + rating', async () => {
    renderWithProviders(<ListingMediaPage />);

    // The reused asset step is hosted against the shadow id + the listing's rating.
    await expect.element(page.getByTestId('asset-step')).toBeInTheDocument();
    await expect.element(page.getByTestId('asset-step')).toHaveTextContent('assets:apl_shadow:pg13');
    expect(state.assetProps.last).toMatchObject({ listingId: 'apl_shadow', contentRating: 'pg13' });
    expect(page.getByTestId('not-found').elements()).toHaveLength(0);
  });

  test('surfaces the honest live-app framing copy', async () => {
    renderWithProviders(<ListingMediaPage />);
    const notice = page.getByTestId('apps-listing-media-live-notice');
    await expect.element(notice).toBeInTheDocument();
    await expect.element(notice).toHaveTextContent(/live/i);
    await expect.element(notice).toHaveTextContent(/moderator re-approves/i);
  });

  test('Submit for review fires submitListingRevision with the shadow id', async () => {
    renderWithProviders(<ListingMediaPage />);
    await expect.element(page.getByTestId('apps-listing-media-submit')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('apps-listing-media-submit'));
    await vi.waitFor(() => expect(state.submit.calls).toHaveLength(1));
    expect(state.submit.calls[0]).toEqual({ shadowId: 'apl_shadow' });
  });

  test('shows the pending-revision notice when a revision is already under review', async () => {
    state.query = {
      data: { appListingId: 'apl_onsite', status: 'approved', contentRating: 'g', hasPendingRevision: true },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<ListingMediaPage />);
    await expect
      .element(page.getByTestId('apps-listing-media-pending-revision-notice'))
      .toBeInTheDocument();
  });

  test('does NOT show the pending-revision notice when none is queued', async () => {
    renderWithProviders(<ListingMediaPage />);
    await expect.element(page.getByTestId('asset-step')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-media-pending-revision-notice').elements()).toHaveLength(0);
  });

  test('fails closed to NotFound when the owner resolve errors (non-owner / missing listing)', async () => {
    state.query = { data: undefined, isLoading: false, error: { message: 'FORBIDDEN' } };
    renderWithProviders(<ListingMediaPage />);
    await expect.element(page.getByTestId('not-found')).toBeInTheDocument();
    expect(page.getByTestId('asset-step').elements()).toHaveLength(0);
  });
});
