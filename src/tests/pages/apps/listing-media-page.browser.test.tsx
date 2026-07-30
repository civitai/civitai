import { useEffect } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { useRouter } from 'next/router';

/**
 * On-site listing-media OWNER editor (`ListingMediaEditor`, the "Listing media" tab of
 * `/apps/<appBlockId>/edit`) — render test (browser mode, report-only in Tekton).
 *
 * Asserts the client wiring: it resolves `appBlockId` → `appListingId`
 * (`getMyListingForApp`), begins the editable shadow revision
 * (`beginListingRevision`), re-hosts the reused `ListingAssetStep` against the
 * SHADOW id + the listing's content rating, prefills it from the SHADOW's assets,
 * re-pulls the projection after an asset mutation, surfaces the honest live-app
 * framing copy (+ the pending-revision notice when applicable), and fires
 * `submitListingRevision({ shadowId })` from the Submit-for-review button. The
 * asset step itself is stubbed — its real behaviour is covered by
 * `ListingAssetStep.browser.test.tsx`.
 *
 * 🔴 This file used to import the default export of `~/pages/apps/[appBlockId]/listing`.
 * That route is now a getServerSideProps REDIRECT stub whose default export renders
 * `<NotFound />` and nothing else, so every test here rendered an empty not-found div
 * and asserted nothing — a structurally dead suite that still reported green. It now
 * targets the real component the route redirects to. Keep it pointed at a COMPONENT.
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
  assetProps: {
    last: null as null | {
      listingId: string;
      contentRating: string;
      initial?: { icon: { imageId: number | null }; cover: { imageId: number | null } };
    },
  },
  // Floor state the stubbed step reports up via onCompletenessChange (drives the
  // submit button's disabled binding). Default meets-floor so the happy paths click.
  floor: { meetsFloor: true, complete: false },
  invalidate: vi.fn().mockResolvedValue(undefined),
  flags: { appBlocks: true } as Record<string, boolean>,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => state.flags,
}));

vi.mock('~/components/AppLayout/NotFound', () => ({
  NotFound: () => <div data-testid="not-found">Not found</div>,
}));
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

// Stub the reused asset step — capture the props to prove the shell threads the
// SHADOW id + rating, without re-running its own (covered) upload behaviour.
vi.mock('~/components/Apps/ListingAssetStep', () => ({
  ListingAssetStep: (props: {
    listingId: string;
    contentRating: string;
    initial?: { icon: { imageId: number | null }; cover: { imageId: number | null } };
    onAssetMutated?: () => void;
    onCompletenessChange?: (s: { meetsFloor: boolean; complete: boolean }) => void;
  }) => {
    state.assetProps.last = props;
    // Mirror the real step: report the floor state up so the page can gate submit.
    // In an EFFECT, not during render — the real step reports from an effect, and
    // calling the parent's setState mid-render trips React's cross-component warning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => props.onCompletenessChange?.(state.floor), []);
    return (
      <div data-testid="asset-step">
        assets:{props.listingId}:{props.contentRating}
        {/* Stands in for a successful attach/remove inside the real step. */}
        <button type="button" data-testid="asset-step-mutate" onClick={() => props.onAssetMutated?.()}>
          mutate
        </button>
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

// 🔴 The REAL editor component — NOT the `/apps/[appBlockId]/listing` route module,
// which is now a redirect stub that only ever renders <NotFound />.
const { ListingMediaEditor } = await import('~/components/Apps/ListingMediaEditor');
const ListingMediaPage = () => <ListingMediaEditor appBlockId="my-block" />;

function setRouterQuery(query: Record<string, string>) {
  const router = (useRouter as unknown as () => { query: Record<string, string> })();
  router.query = query;
}

beforeEach(() => {
  state.query = {
    data: {
      appListingId: 'apl_onsite',
      status: 'approved',
      contentRating: 'pg13',
      hasPendingRevision: false,
      shadowId: 'apl_shadow',
      // The SHADOW's assets — what the proc now projects so the step can prefill.
      assets: {
        icon: { imageId: 137918008, url: 'edge:icon' },
        cover: { imageId: 137918011, url: 'edge:cover' },
        screenshots: [],
      },
    },
    isLoading: false,
    error: null,
  };
  state.begin = { shadowId: 'apl_shadow', error: null, pending: false };
  state.submit = { calls: [], pending: false };
  state.floor = { meetsFloor: true, complete: false };
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

  test('prefills the asset step with the SHADOW revision assets the proc projects', async () => {
    renderWithProviders(<ListingMediaPage />);

    await expect.element(page.getByTestId('asset-step')).toBeInTheDocument();
    // Without this prop the step seeded every slot empty → "Icon none / Cover none"
    // → the publish floor could never be met → Submit stayed permanently disabled.
    expect(state.assetProps.last?.initial).toMatchObject({
      icon: { imageId: 137918008 },
      cover: { imageId: 137918011 },
    });
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

  test('the Submit button is ENABLED when the step reports it meets the floor (icon+cover)', async () => {
    state.floor = { meetsFloor: true, complete: false };
    renderWithProviders(<ListingMediaPage />);
    const submit = page.getByTestId('apps-listing-media-submit');
    await expect.element(submit).toBeInTheDocument();
    await expect.element(submit).not.toBeDisabled();
  });

  test('the Submit button is DISABLED when the step reports it is below the floor', async () => {
    state.floor = { meetsFloor: false, complete: false };
    renderWithProviders(<ListingMediaPage />);
    const submit = page.getByTestId('apps-listing-media-submit');
    await expect.element(submit).toBeInTheDocument();
    await expect.element(submit).toBeDisabled();
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
    state.query = {
      data: undefined,
      isLoading: false,
      error: { message: 'you can only manage your own listings', data: { code: 'FORBIDDEN' } },
    };
    renderWithProviders(<ListingMediaPage />);
    await expect.element(page.getByTestId('not-found')).toBeInTheDocument();
    expect(page.getByTestId('asset-step').elements()).toHaveLength(0);
  });

  test('a NON-owner-gating error surfaces the inline alert instead of collapsing to NotFound', async () => {
    // `getMyListingForApp` now resolves the shadow server-side, so an INVALID_REVISION
    // ("cannot edit a listing in status …") arrives here as BAD_REQUEST. Blanket-
    // NotFound'ing it hid the one surface that explains it and told the owner their
    // LIVE app did not exist.
    state.query = {
      data: undefined,
      isLoading: false,
      error: { message: 'cannot edit a listing in status removed', data: { code: 'BAD_REQUEST' } },
    };
    renderWithProviders(<ListingMediaPage />);
    const alert = page.getByTestId('apps-listing-media-begin-error');
    await expect.element(alert).toBeInTheDocument();
    await expect.element(alert).toHaveTextContent(/cannot edit a listing in status removed/i);
    expect(page.getByTestId('not-found').elements()).toHaveLength(0);
  });

  test('re-pulls the projected assets after an asset mutation (stale-prefill guard)', async () => {
    renderWithProviders(<ListingMediaPage />);
    await expect.element(page.getByTestId('asset-step')).toBeInTheDocument();
    expect(state.invalidate).not.toHaveBeenCalled();

    // The step reports a successful attach/remove.
    await userEvent.click(page.getByTestId('asset-step-mutate'));

    // Without this the cached `assets` stay pre-mutation and the /edit page's
    // `keepMounted={false}` tab round-trip re-seeds the step from them — a just-
    // attached icon reads as unattached and Submit goes disabled again.
    await vi.waitFor(() => expect(state.invalidate).toHaveBeenCalledWith({ appBlockId: 'my-block' }));
  });
});
