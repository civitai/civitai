import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 post-approval mgmt (P2) — the unified moderator listings management table.
 * Browser-mode render test (report-only in Tekton): mixed-status/kind dataset →
 * status sections; sort + server-side filter wiring; each inline action fires the
 * right mutation with the right args (reason forwarded, purge confirm-gated); the
 * kind-aware action visibility (off-site-only actions hidden on on-site rows); the
 * pending Review action opens the reused off-site review modal with the correct
 * request id; and error surfacing.
 */

function offsite(over: Record<string, unknown>) {
  return {
    kind: 'offsite',
    category: 'utility',
    contentRating: 'g',
    externalUrl: 'https://ex.com/app',
    appBlockId: null,
    owner: { id: 1, username: 'dev', image: null },
    installCount: 0,
    thumbsUpCount: 0,
    thumbsDownCount: 0,
    pendingRequest: null,
    ...over,
  };
}

const ROWS = [
  offsite({
    id: 'apl_p',
    slug: 'pending-ext',
    name: 'Pending Ext',
    status: 'pending',
    pendingRequest: {
      id: 'alpr_p',
      submittedAt: new Date('2026-01-01T00:00:00Z'),
      changelog: 'a note',
      submittedBy: { id: 1, username: 'dev', image: null },
    },
  }),
  // Server (keyset) order is NOT alphabetical (Bravo precedes Alpha) so a client
  // A→Z sort is observable as a flip.
  offsite({ id: 'apl_b', slug: 'bravo-live', name: 'Bravo', status: 'approved' }),
  offsite({ id: 'apl_a', slug: 'alpha-live', name: 'Alpha', status: 'approved' }),
  offsite({ id: 'apl_o', slug: 'onsite-live', name: 'Onsite', kind: 'onsite', appBlockId: 'ab_1', status: 'approved' }),
  offsite({ id: 'apl_r', slug: 'gone-ext', name: 'Gone', status: 'removed' }),
];

// Two-page dataset (paged mode) — page 1 carries a nextCursor, page 2 does not.
const PAGE1 = [offsite({ id: 'apl_a', slug: 'alpha-live', name: 'Alpha', status: 'approved' })];
const PAGE2 = [offsite({ id: 'apl_z', slug: 'zebra-live', name: 'Zebra', status: 'approved' })];

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
  queryInput: vi.fn(),
  errorMode: false,
  queryError: false,
  paged: false,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));

const showError = vi.fn();
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: (...a: unknown[]) => showError(...a),
}));

vi.mock('~/utils/trpc', () => {
  // A mutation mock: records (name, vars), then drives onSuccess/onError so the
  // component's success + error paths both run.
  const mutation =
    (name: string) =>
    (opts?: { onSuccess?: () => void; onError?: (e: { message: string }) => void }) => ({
      mutate: (vars: unknown) => {
        mocks.mutate(name, vars);
        if (mocks.errorMode) opts?.onError?.({ message: 'boom' });
        else void opts?.onSuccess?.();
      },
      mutateAsync: vi.fn(),
      isPending: false,
    });
  const utils = {
    appListings: {
      listAllListingsForModeration: { invalidate: mocks.invalidate },
      listPendingRequests: { invalidate: mocks.invalidate },
      listApprovedRequests: { invalidate: mocks.invalidate },
      listRejectedRequests: { invalidate: mocks.invalidate },
    },
  };
  return {
    trpc: {
      useUtils: () => utils,
      appListings: {
        listAllListingsForModeration: {
          useQuery: (input: { cursor?: string }) => {
            mocks.queryInput(input);
            if (mocks.queryError) {
              return { data: undefined, isLoading: false, isFetching: false, error: new Error('nope') };
            }
            if (mocks.paged) {
              const data = input?.cursor
                ? { items: PAGE2, nextCursor: null }
                : { items: PAGE1, nextCursor: 'cur-2' };
              return { data, isLoading: false, isFetching: false, error: null };
            }
            return {
              data: { items: ROWS, nextCursor: null },
              isLoading: false,
              isFetching: false,
              error: null,
            };
          },
        },
        // The reused off-site review modal's deps:
        getAssets: {
          useQuery: () => ({
            data: {
              listingId: 'apl_p',
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
        // Lifecycle + review mutations.
        resetListingToPending: { useMutation: mutation('reset') },
        delistListing: { useMutation: mutation('delist') },
        relistListing: { useMutation: mutation('relist') },
        claimListing: { useMutation: mutation('claim') },
        purgeListing: { useMutation: mutation('purge') },
        approveExternalRequest: { useMutation: mutation('approve') },
        rejectExternalRequest: { useMutation: mutation('reject') },
      },
    },
  };
});

const { AppListingsModerationTable } = await import('./AppListingsModerationTable');

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.mutate.mockClear();
  mocks.queryInput.mockClear();
  mocks.errorMode = false;
  mocks.queryError = false;
  mocks.paged = false;
  showError.mockClear();
});

describe('AppListingsModerationTable — sections + kind-aware visibility', () => {
  test('renders the mixed-status dataset into status sections', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await expect.element(page.getByTestId('apps-mod-listings-section-live')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mod-listings-section-pending')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mod-listings-section-removed')).toBeInTheDocument();
    // Rows from different sections are present.
    await expect.element(page.getByText('pending-ext')).toBeInTheDocument();
    await expect.element(page.getByText('alpha-live')).toBeInTheDocument();
    await expect.element(page.getByText('gone-ext')).toBeInTheDocument();
  });

  test('off-site-only actions are hidden on an on-site row (kind-aware)', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    // Off-site approved → BOTH reset-to-pending + hide.
    await expect.element(page.getByTestId('apps-mod-reset-to-pending-alpha-live')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mod-hide-alpha-live')).toBeInTheDocument();
    // On-site approved → hide ONLY (no reset-to-pending).
    await expect.element(page.getByTestId('apps-mod-hide-onsite-live')).toBeInTheDocument();
    expect(page.getByTestId('apps-mod-reset-to-pending-onsite-live').elements()).toHaveLength(0);
    // Removed off-site → relist + claim + purge.
    await expect.element(page.getByTestId('apps-mod-relist-gone-ext')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mod-claim-gone-ext')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mod-purge-gone-ext')).toBeInTheDocument();
  });
});

describe('AppListingsModerationTable — sort + server-side filter', () => {
  test('the App column client-sort reorders the loaded rows (server order → A→Z on click)', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await expect.element(page.getByTestId('apps-mod-listing-row-alpha-live')).toBeInTheDocument();
    // Default = the server keyset order (Bravo precedes Alpha) — NOT a client A→Z.
    const before =
      page.getByTestId('apps-mod-listing-row-alpha-live').element()
        .compareDocumentPosition(page.getByTestId('apps-mod-listing-row-bravo-live').element());
    expect(before & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy(); // bravo precedes alpha

    await page.getByRole('button', { name: 'Sort by App' }).first().click();
    const after =
      page.getByTestId('apps-mod-listing-row-alpha-live').element()
        .compareDocumentPosition(page.getByTestId('apps-mod-listing-row-bravo-live').element());
    // A→Z: Alpha now precedes Bravo.
    expect(after & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('typing in the filter forwards `search` to the server query', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-listings-filter').fill('cool');
    const lastInput = mocks.queryInput.mock.calls.at(-1)?.[0] as { search?: string };
    expect(lastInput.search).toBe('cool');
  });
});

describe('AppListingsModerationTable — inline actions fire the right mutation', () => {
  test('Hide forwards {appListingId, reason} to delistListing (dual-kind)', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-hide-alpha-live').click();
    await page.getByTestId('apps-mod-action-reason').fill('spammy content');
    await page.getByTestId('apps-mod-action-confirm').click();
    expect(mocks.mutate).toHaveBeenCalledWith('delist', {
      appListingId: 'apl_a',
      reason: 'spammy content',
    });
  });

  test('Reset to pending forwards {appListingId, reason} (off-site only)', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-reset-to-pending-alpha-live').click();
    await page.getByTestId('apps-mod-action-reason').fill('needs re-review');
    await page.getByTestId('apps-mod-action-confirm').click();
    expect(mocks.mutate).toHaveBeenCalledWith('reset', {
      appListingId: 'apl_a',
      reason: 'needs re-review',
    });
  });

  // Relist is the SOLE recovery path for a mistaken takedown — a removed row must
  // be restorable. The button's presence is covered above; here assert clicking it
  // through the reason gate actually FIRES relistListing with {appListingId, reason}.
  test('Relist on a removed row forwards {appListingId, reason} to relistListing', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-relist-gone-ext').click();
    await page.getByTestId('apps-mod-action-reason').fill('takedown was a mistake');
    await page.getByTestId('apps-mod-action-confirm').click();
    expect(mocks.mutate).toHaveBeenCalledWith('relist', {
      appListingId: 'apl_r',
      reason: 'takedown was a mistake',
    });
  });

  test('Claim forwards the target owner id + reason', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-claim-gone-ext').click();
    await page.getByTestId('apps-mod-claim-target').fill('555');
    await page.getByTestId('apps-mod-action-reason').fill('verified owner');
    await page.getByTestId('apps-mod-action-confirm').click();
    expect(mocks.mutate).toHaveBeenCalledWith('claim', {
      appListingId: 'apl_r',
      targetUserId: 555,
      reason: 'verified owner',
    });
  });

  test('Purge is typed-confirm gated: needs BOTH reason ≥3 AND the exact slug, then fires', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-purge-gone-ext').click();
    // Destructive warning + a disabled confirm while nothing is entered.
    await expect.element(page.getByTestId('apps-mod-action-confirm')).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();

    // Reason alone is NOT enough — the typed slug confirm is still required.
    await page.getByTestId('apps-mod-action-reason').fill('malware');
    await expect.element(page.getByTestId('apps-mod-action-confirm')).toBeDisabled();

    // A WRONG slug keeps it disabled.
    await page.getByTestId('apps-mod-purge-confirm').fill('wrong-slug');
    await expect.element(page.getByTestId('apps-mod-action-confirm')).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();

    // The exact slug (+ reason) enables it → fires with the right args.
    await page.getByTestId('apps-mod-purge-confirm').fill('gone-ext');
    await expect.element(page.getByTestId('apps-mod-action-confirm')).toBeEnabled();
    await page.getByTestId('apps-mod-action-confirm').click();
    expect(mocks.mutate).toHaveBeenCalledWith('purge', { appListingId: 'apl_r', reason: 'malware' });
  });

  test('a reason under the 3-char floor keeps the confirm disabled', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-hide-alpha-live').click();
    await page.getByTestId('apps-mod-action-reason').fill('ab');
    await expect.element(page.getByTestId('apps-mod-action-confirm')).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test('a mutation error surfaces via showErrorNotification', async () => {
    mocks.errorMode = true;
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-hide-alpha-live').click();
    await page.getByTestId('apps-mod-action-reason').fill('spammy content');
    await page.getByTestId('apps-mod-action-confirm').click();
    expect(showError).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Hide failed' })
    );
  });
});

describe('AppListingsModerationTable — pending Review opens the review modal', () => {
  test('Review opens the off-site review modal and approve forwards the pending request id', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-review-pending-ext').click();
    // The reused off-site review modal opened (content-only checklist).
    await expect
      .element(page.getByText('URL is https and opens externally'))
      .toBeInTheDocument();
    await page.getByTestId('apps-offsite-approve-open').click();
    await page.getByTestId('apps-offsite-approve-confirm').click();
    // Approve fires with the pending request id from the row (NOT the listing id).
    expect(mocks.mutate).toHaveBeenCalledWith(
      'approve',
      expect.objectContaining({ publishRequestId: 'alpr_p' })
    );
  });
});

describe('AppListingsModerationTable — pagination, status filter + honest truncation', () => {
  test('Load more appends the next keyset page and hides once the cursor is exhausted', async () => {
    mocks.paged = true;
    renderWithProviders(<AppListingsModerationTable />);
    // Page 1 only: alpha visible, zebra NOT yet, Load-more present.
    await expect.element(page.getByTestId('apps-mod-listing-row-alpha-live')).toBeInTheDocument();
    expect(page.getByTestId('apps-mod-listing-row-zebra-live').elements()).toHaveLength(0);
    await expect.element(page.getByTestId('apps-mod-load-more')).toBeInTheDocument();

    await page.getByTestId('apps-mod-load-more').click();
    // Page 2 appended: BOTH rows now render, and Load-more is gone (nextCursor null).
    await expect.element(page.getByTestId('apps-mod-listing-row-zebra-live')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mod-listing-row-alpha-live')).toBeInTheDocument();
    expect(page.getByTestId('apps-mod-load-more').elements()).toHaveLength(0);
  });

  test('the truncation indicator shows a "+more" count + Load-more only while a next page exists', async () => {
    mocks.paged = true;
    renderWithProviders(<AppListingsModerationTable />);
    // Page 1 truncated → the count flags that more exist, and Load-more shows.
    await expect
      .element(page.getByTestId('apps-mod-listings-count'))
      .toHaveTextContent('Showing 1+');
    await expect.element(page.getByTestId('apps-mod-load-more')).toBeInTheDocument();
  });

  test('the count reads a plain total (no "+", no Load-more) when nothing is truncated', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    const count = page.getByTestId('apps-mod-listings-count');
    await expect.element(count).toHaveTextContent('Showing 5');
    expect((count.element().textContent ?? '').includes('+')).toBe(false);
    expect(page.getByTestId('apps-mod-load-more').elements()).toHaveLength(0);
  });

  test('selecting a status re-queries the server with that `status` arg', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByRole('radio', { name: 'Removed' }).click();
    const lastInput = mocks.queryInput.mock.calls.at(-1)?.[0] as { status?: string };
    expect(lastInput.status).toBe('removed');
  });
});

describe('AppListingsModerationTable — dark posture', () => {
  test('renders nothing when the query errors (non-mod / flag off)', async () => {
    mocks.queryError = true;
    renderWithProviders(<AppListingsModerationTable />);
    // The component returns null on a query error → none of its surface renders.
    expect(page.getByTestId('apps-mod-listings-filter').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-mod-listing-row-alpha-live').elements()).toHaveLength(0);
  });
});
