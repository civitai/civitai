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
  // D: an on-site + pending listing — it belongs to the on-site review FIFO queue, so
  // the mgmt table must HIDE it (it would otherwise be a dead-end `—`-action row).
  offsite({
    id: 'apl_op',
    slug: 'onsite-pending',
    name: 'Onsite Pending',
    kind: 'onsite',
    appBlockId: 'ab_2',
    status: 'pending',
    pendingRequest: {
      id: 'alpr_op',
      submittedAt: new Date('2026-01-01T00:00:00Z'),
      changelog: null,
      submittedBy: { id: 1, username: 'dev', image: null },
    },
  }),
];

// Two-page dataset (paged mode) — page 1 carries a nextCursor, page 2 does not.
const PAGE1 = [offsite({ id: 'apl_a', slug: 'alpha-live', name: 'Alpha', status: 'approved' })];
const PAGE2 = [offsite({ id: 'apl_z', slug: 'zebra-live', name: 'Zebra', status: 'approved' })];

// D-stranding regression fixtures: page 1 is a FULL page (PAGE_SIZE=50) of on-site
// pending rows (every one filtered out by D) but has a next cursor; page 2 has a
// visible off-site row. Without the fix, page 1's empty post-filter set would render
// the "No listings match" dead end and suppress Load-more → page 2 unreachable.
const STRANDED_PAGE1 = Array.from({ length: 50 }, (_, i) =>
  offsite({
    id: `apl_sp_${i}`,
    slug: `stranded-onsite-${i}`,
    name: `Stranded ${i}`,
    kind: 'onsite',
    appBlockId: `ab_sp_${i}`,
    status: 'pending',
    pendingRequest: {
      id: `alpr_sp_${i}`,
      submittedAt: new Date('2026-01-01T00:00:00Z'),
      changelog: null,
      submittedBy: { id: 1, username: 'dev', image: null },
    },
  })
);
const STRANDED_PAGE2 = [
  offsite({ id: 'apl_reach', slug: 'reachable-ext', name: 'Reachable', status: 'approved' }),
];

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
  queryInput: vi.fn(),
  refetch: vi.fn(),
  errorMode: false,
  queryError: false,
  // null → a transient (non-authz) error (Alert + Retry); a code string → an authz
  // error (render nothing).
  queryErrorCode: null as string | null,
  paged: false,
  // D-stranding regression: page 1 is a FULL server page of on-site pending rows (all
  // filtered out client-side) but a next cursor exists; page 2 carries a visible row.
  strandedD: false,
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
              const error = mocks.queryErrorCode
                ? Object.assign(new Error('forbidden'), { data: { code: mocks.queryErrorCode } })
                : Object.assign(new Error('transient boom'), { data: { code: 'INTERNAL_SERVER_ERROR' } });
              return {
                data: undefined,
                isLoading: false,
                isFetching: false,
                error,
                refetch: mocks.refetch,
              };
            }
            if (mocks.strandedD) {
              // Page 1: a full PAGE_SIZE page of on-site pending rows (all filtered by
              // D) + a next cursor. Page 2: one visible off-site approved row, no cursor.
              const data = input?.cursor
                ? { items: STRANDED_PAGE2, nextCursor: null }
                : { items: STRANDED_PAGE1, nextCursor: 'cur-2' };
              return { data, isLoading: false, isFetching: false, error: null, refetch: mocks.refetch };
            }
            if (mocks.paged) {
              const data = input?.cursor
                ? { items: PAGE2, nextCursor: null }
                : { items: PAGE1, nextCursor: 'cur-2' };
              return { data, isLoading: false, isFetching: false, error: null, refetch: mocks.refetch };
            }
            return {
              data: { items: ROWS, nextCursor: null },
              isLoading: false,
              isFetching: false,
              error: null,
              refetch: mocks.refetch,
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
        resetOnsiteListingToPending: { useMutation: mutation('resetOnsite') },
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
  mocks.refetch.mockClear();
  mocks.errorMode = false;
  mocks.queryError = false;
  mocks.queryErrorCode = null;
  mocks.paged = false;
  mocks.strandedD = false;
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
    // On-site approved → reset-to-pending (now dual-kind, #3165) + hide, but NEVER the
    // off-site-only claim/purge (those don't apply to an on-site row).
    await expect.element(page.getByTestId('apps-mod-hide-onsite-live')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-mod-reset-to-pending-onsite-live'))
      .toBeInTheDocument();
    // Removed off-site → relist + claim + purge.
    await expect.element(page.getByTestId('apps-mod-relist-gone-ext')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mod-claim-gone-ext')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mod-purge-gone-ext')).toBeInTheDocument();
  });

  // D — an on-site + pending listing is the actionable on-site review queue's job; the
  // mgmt table filters it out so it isn't a dead-end row. An OFF-SITE pending row (which
  // carries the Review action) still shows.
  test('an on-site + pending row is hidden from the table, while off-site pending shows', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    // Off-site pending still present (has the Review action).
    await expect.element(page.getByTestId('apps-mod-listing-row-pending-ext')).toBeInTheDocument();
    // On-site pending filtered out entirely (no row, no dead-end).
    expect(page.getByTestId('apps-mod-listing-row-onsite-pending').elements()).toHaveLength(0);
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

  // F — the search is DEBOUNCED: the typed value reaches the server query (eventually),
  // rather than firing one query per keystroke.
  test('typing in the filter forwards the (debounced) `search` to the server query', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-listings-filter').fill('cool');
    await vi.waitFor(() => {
      const lastInput = mocks.queryInput.mock.calls.at(-1)?.[0] as { search?: string };
      expect(lastInput.search).toBe('cool');
    });
  });

  // F — a filter change mid-pagination must reset the cursor SYNCHRONOUSLY, so no query
  // ever fires pairing the OLD cursor with the NEW filter (the stale-cursor window).
  test('changing a filter mid-pagination resets the cursor with no stale-cursor query', async () => {
    mocks.paged = true;
    renderWithProviders(<AppListingsModerationTable />);
    // Page to cursor 'cur-2'.
    await page.getByTestId('apps-mod-load-more').click();
    await vi.waitFor(() => {
      const withCursor = mocks.queryInput.mock.calls.find(([i]) => i?.cursor === 'cur-2');
      expect(withCursor).toBeTruthy();
    });
    // Now change the status filter.
    await page.getByRole('radio', { name: 'Removed' }).click();
    // No query was ever fired with the OLD cursor AND the NEW status together.
    const stale = mocks.queryInput.mock.calls.find(
      ([i]) => i?.cursor === 'cur-2' && i?.status === 'removed'
    );
    expect(stale).toBeUndefined();
    // The post-change query uses the NEW status with a CLEARED cursor.
    await vi.waitFor(() => {
      const last = mocks.queryInput.mock.calls.at(-1)?.[0] as { status?: string; cursor?: string };
      expect(last.status).toBe('removed');
      expect(last.cursor).toBeUndefined();
    });
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

  test('Reset to pending on an OFF-SITE row forwards {appListingId, reason} to the offsite proc', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-reset-to-pending-alpha-live').click();
    await page.getByTestId('apps-mod-action-reason').fill('needs re-review');
    await page.getByTestId('apps-mod-action-confirm').click();
    expect(mocks.mutate).toHaveBeenCalledWith('reset', {
      appListingId: 'apl_a',
      reason: 'needs re-review',
    });
  });

  // Onsite reset UI wiring (#3165): an on-site approved row now offers Reset, and it
  // must route to the ON-SITE proc (resetOnsiteListingToPending), NOT the off-site one.
  test('Reset to pending on an ON-SITE row fires the ONSITE proc with {appListingId, reason}', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-reset-to-pending-onsite-live').click();
    await page.getByTestId('apps-mod-action-reason').fill('re-review this block');
    await page.getByTestId('apps-mod-action-confirm').click();
    expect(mocks.mutate).toHaveBeenCalledWith('resetOnsite', {
      appListingId: 'apl_o',
      reason: 're-review this block',
    });
    // And NOT the off-site reset proc.
    expect(mocks.mutate).not.toHaveBeenCalledWith('reset', expect.anything());
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

  test('a reason under the 3-char floor keeps the confirm disabled + shows the live counter', async () => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId('apps-mod-hide-alpha-live').click();
    // The live counter is present from the empty state (matches the reject paths' UX).
    await expect.element(page.getByText('0/3 characters minimum')).toBeInTheDocument();
    await page.getByTestId('apps-mod-action-reason').fill('ab');
    await expect.element(page.getByText('2/3 characters minimum')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mod-action-confirm')).toBeDisabled();
    // The inline too-short error surfaces once something is typed.
    await expect.element(page.getByText('Enter at least 3 characters.')).toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  // Finding A: EVERY post-approval action modal now carries the reason gate (counter +
  // disabled-under-floor), not just the two reject paths. Cover each action's open→gate.
  test.each([
    ['reset-to-pending', 'alpha-live'],
    ['hide', 'alpha-live'],
    ['relist', 'gone-ext'],
    ['claim', 'gone-ext'],
    ['purge', 'gone-ext'],
  ])('the %s action shows the counter and disables the confirm under the floor', async (action, slug) => {
    renderWithProviders(<AppListingsModerationTable />);
    await page.getByTestId(`apps-mod-${action}-${slug}`).click();
    await expect.element(page.getByText('0/3 characters minimum')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-mod-action-confirm')).toBeDisabled();
    await page.getByTestId('apps-mod-action-reason').fill('xy');
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

  // D-stranding regression: a full server page of on-site pending rows (all filtered
  // out by D) with a next cursor must STILL render Load-more — the empty post-filter
  // page must not win the empty-state branch and strand the later (matching) pages.
  test('a fully-filtered page with a next cursor still renders Load-more (D does not strand later pages)', async () => {
    mocks.strandedD = true;
    renderWithProviders(<AppListingsModerationTable />);
    // Load-more IS present (a next cursor exists), even though the page rendered no rows.
    await expect.element(page.getByTestId('apps-mod-load-more')).toBeInTheDocument();
    // Page 1: every row filtered out → NO rows, and the dead-end empty state must NOT show.
    expect(page.getByTestId('apps-mod-listing-row-stranded-onsite-0').elements()).toHaveLength(0);
    expect(page.getByText('No listings match the current filters.').elements()).toHaveLength(0);

    // Clicking it fetches page 2 → the previously-unreachable off-site row appears.
    await page.getByTestId('apps-mod-load-more').click();
    await expect.element(page.getByTestId('apps-mod-listing-row-reachable-ext')).toBeInTheDocument();
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

describe('AppListingsModerationTable — dark posture + error resilience (C)', () => {
  test('renders nothing on an AUTHZ error (non-mod / flag off)', async () => {
    mocks.queryError = true;
    mocks.queryErrorCode = 'FORBIDDEN';
    renderWithProviders(<AppListingsModerationTable />);
    // The component returns null on an authz error → none of its surface renders.
    expect(page.getByTestId('apps-mod-listings-filter').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-mod-listing-row-alpha-live').elements()).toHaveLength(0);
    // Crucially NOT the transient-error retry Alert.
    expect(page.getByTestId('apps-mod-listings-error').elements()).toHaveLength(0);
  });

  // A transient 500 / network blip must NOT silently blank the surface — it renders a
  // retryable Alert (so a flaky load is recoverable, not indistinguishable from "not a mod").
  test('a TRANSIENT (non-authz) error renders an Alert + a Retry that refetches', async () => {
    mocks.queryError = true;
    mocks.queryErrorCode = null; // → INTERNAL_SERVER_ERROR (non-authz)
    renderWithProviders(<AppListingsModerationTable />);
    await expect.element(page.getByTestId('apps-mod-listings-error')).toBeInTheDocument();
    // The intended dark surface (filter/rows) is NOT rendered under an error.
    expect(page.getByTestId('apps-mod-listings-filter').elements()).toHaveLength(0);
    // Retry calls refetch().
    await page.getByTestId('apps-mod-listings-error-retry').click();
    expect(mocks.refetch).toHaveBeenCalled();
  });
});
