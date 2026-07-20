import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * PR3 — OAuth-connect mod review UI. Two seams:
 *  1. `ConnectScopesPanel` (pure props): the requested-scope disclosure a moderator
 *     reviews — scope keys + descriptions + per-scope justifications, with SENSITIVE
 *     scopes flagged in a distinct group and a "No justification provided" fallback.
 *  2. `OffsiteReviewModal` conditional: the panel is rendered ONLY for a CONNECT
 *     listing (`connectClientId != null`), never for an external-link listing.
 */

// --- trpc / providers mocked for the OffsiteReviewModal conditional tests. The
// pure-props ConnectScopesPanel tests below don't touch these. ---
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/utils/trpc', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    trpc: {
      useUtils: () => ({
        appListings: {
          listPendingRequests: { invalidate: vi.fn() },
          listApprovedRequests: { invalidate: vi.fn() },
          listRejectedRequests: { invalidate: vi.fn() },
        },
      }),
      appListings: {
        getAssets: {
          useQuery: () => ({
            data: {
              listingId: 'listing-c',
              iconId: 10,
              coverId: 11,
              iconNsfwLevel: 1,
              coverNsfwLevel: 1,
              screenshots: [{ imageId: 12, nsfwLevel: 1 }],
            },
            isLoading: false,
            error: null,
          }),
        },
        approveExternalRequest: { useMutation: mutation },
        rejectExternalRequest: { useMutation: mutation },
      },
    },
  };
});

const { ConnectScopesPanel } = await import('./ConnectScopesPanel');
const { OffsiteReviewModal } = await import('./OffsiteReviewQueue');

// ModelsWrite (sensitive, justified) + ModelsRead (normal, UNjustified → fallback).
const REQUESTED = TokenScope.ModelsWrite | TokenScope.ModelsRead;
const JUSTIFICATIONS = { ModelsWrite: 'We publish edited models on the user behalf.' };

describe('ConnectScopesPanel — pure props', () => {
  test('renders each scope key + its description + the justification', async () => {
    renderWithProviders(
      <ConnectScopesPanel
        connectClientName="Acme OAuth App"
        requestedScopes={REQUESTED}
        justifications={JUSTIFICATIONS}
      />
    );
    // Both scope keys render.
    await expect.element(page.getByText('ModelsWrite')).toBeInTheDocument();
    await expect.element(page.getByText('ModelsRead')).toBeInTheDocument();
    // The human-readable description (from tokenScopeLabels) renders.
    await expect.element(page.getByText('Upload & edit models')).toBeInTheDocument();
    // The client name renders.
    await expect.element(page.getByText('Client: Acme OAuth App')).toBeInTheDocument();
    // The justification renders next to its scope.
    await expect
      .element(page.getByText('We publish edited models on the user behalf.'))
      .toBeInTheDocument();
  });

  test('a SENSITIVE scope appears in the sensitive group with the Sensitive badge', async () => {
    renderWithProviders(
      <ConnectScopesPanel requestedScopes={REQUESTED} justifications={JUSTIFICATIONS} />
    );
    // The sensitive group is present…
    await expect.element(page.getByTestId('connect-scopes-sensitive-group')).toBeInTheDocument();
    // …and carries exactly ONE sensitive badge (ModelsWrite; ModelsRead is normal).
    expect(page.getByTestId('sensitive-scope-badge').elements()).toHaveLength(1);
    // ModelsWrite (sensitive) is inside the sensitive group.
    const group = page.getByTestId('connect-scopes-sensitive-group');
    await expect.element(group.getByText('ModelsWrite')).toBeInTheDocument();
  });

  test('an unjustified scope shows the "No justification provided" fallback', async () => {
    renderWithProviders(
      <ConnectScopesPanel requestedScopes={REQUESTED} justifications={JUSTIFICATIONS} />
    );
    // ModelsRead has no justification → the muted fallback shows exactly once.
    await expect.element(page.getByText('No justification provided')).toBeInTheDocument();
    expect(page.getByText('No justification provided').elements()).toHaveLength(1);
  });

  test('empty justifications → every scope shows the fallback', async () => {
    renderWithProviders(<ConnectScopesPanel requestedScopes={REQUESTED} justifications={null} />);
    // Await the render before the synchronous count.
    await expect.element(page.getByText('No justification provided').first()).toBeInTheDocument();
    expect(page.getByText('No justification provided').elements()).toHaveLength(2);
  });
});

// A pending row feeding OffsiteReviewModal. Overridable per-test for the
// connect vs external-link conditional.
function makeRow(appListing: Record<string, unknown>) {
  return {
    id: 'req-c',
    appListingId: 'listing-c',
    slug: 'connect-app',
    status: 'pending',
    submittedAt: new Date('2026-01-01T00:00:00Z'),
    changelog: null,
    appListing,
    submittedBy: { id: 42, username: 'dev', image: null },
  } as never;
}

describe('OffsiteReviewModal — ConnectScopesPanel conditional', () => {
  test('renders the ConnectScopesPanel for a CONNECT listing (connectClientId set)', async () => {
    renderWithProviders(
      <OffsiteReviewModal
        request={makeRow({
          name: 'Connect App',
          externalUrl: null,
          category: 'utility',
          contentRating: 'g',
          connectClientId: 'client-1',
          connectRequestedScopes: REQUESTED,
          connectScopeJustifications: JUSTIFICATIONS,
          connectClient: { name: 'Acme OAuth App' },
        })}
        onClose={() => undefined}
      />
    );
    await expect.element(page.getByTestId('connect-scopes-panel')).toBeInTheDocument();
    await expect.element(page.getByText('ModelsWrite')).toBeInTheDocument();
  });

  test('does NOT render the ConnectScopesPanel for an external-link listing (connectClientId null)', async () => {
    renderWithProviders(
      <OffsiteReviewModal
        request={makeRow({
          name: 'External App',
          externalUrl: 'https://example.com/app',
          category: 'utility',
          contentRating: 'g',
          connectClientId: null,
          connectRequestedScopes: null,
          connectScopeJustifications: null,
          connectClient: null,
        })}
        onClose={() => undefined}
      />
    );
    // The external URL confirms the modal mounted…
    await expect.element(page.getByText('https://example.com/app')).toBeInTheDocument();
    // …but the connect scope panel is absent.
    expect(page.getByTestId('connect-scopes-panel').elements()).toHaveLength(0);
  });
});
