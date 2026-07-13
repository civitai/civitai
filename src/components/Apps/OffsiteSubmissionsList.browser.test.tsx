import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * /apps/my-submissions OFF-SITE list — status-section restructure (UX pass) + the
 * W13 post-approval-mgmt OWNER controls (Phase 3): unpublish/republish, the
 * moderation-history modal, and the surfaced shadow-revision Edit link.
 *
 * The list transitively imports `MySubmissionsList` (for `ReviewerNotesButton`),
 * which pulls in the analytics inline stat → `~/utils/trpc`, mocked so this stays
 * network-free. Per the documented gotcha, the wholesale `~/utils/trpc` mock
 * includes `setTrpcBatchingEnabled` (a graph-reachable module imports it). Phase 3
 * added the owner-control mutations (`unpublishOwnListing`/`republishOwnListing`),
 * the owner history query (`listMyListingModerationEvents`), and `trpc.useUtils()`
 * (for the on-success invalidate) — all mocked below.
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn().mockResolvedValue(undefined),
  historyItems: [] as Array<{
    id: string;
    action: string;
    reason: string | null;
    createdAt: Date;
  }>,
}));

const showError = vi.fn();
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: (...a: unknown[]) => showError(...a),
}));

vi.mock('~/utils/trpc', () => {
  // A mutation mock: records (name, vars), then drives onSuccess so the invalidate +
  // notification paths run.
  const mutation =
    (name: string) =>
    (opts?: { onSuccess?: () => void; onError?: (e: { message: string }) => void }) => ({
      mutate: (vars: unknown) => {
        mocks.mutate(name, vars);
        void opts?.onSuccess?.();
      },
      isPending: false,
    });
  return {
    trpc: {
      useUtils: () => ({
        appListings: { listMySubmissions: { invalidate: mocks.invalidate } },
      }),
      blocks: {
        getMyAppAnalytics: {
          useQuery: () => ({
            data: { runs: { count: 0 }, engagement: { activeUsers: 0 } },
            isLoading: false,
          }),
        },
      },
      appListings: {
        unpublishOwnListing: { useMutation: mutation('unpublish') },
        republishOwnListing: { useMutation: mutation('republish') },
        listMyListingModerationEvents: {
          useQuery: () => ({
            data: { items: mocks.historyItems, nextCursor: null },
            isLoading: false,
            error: null,
          }),
        },
      },
    },
    setTrpcBatchingEnabled: vi.fn(),
  };
});

import type { OffsiteSubmission } from './OffsiteSubmissionsList';
const { OffsiteSubmissionsList } = await import('./OffsiteSubmissionsList');

beforeEach(() => {
  mocks.mutate.mockClear();
  mocks.invalidate.mockClear();
  mocks.historyItems = [];
  showError.mockClear();
});

function makeOffsite(overrides: Partial<OffsiteSubmission>): OffsiteSubmission {
  const status = overrides.status ?? 'approved';
  // Default the TRUE listing status to mirror the request status (the common case);
  // tests override `appListing.status` + `lastModerationAction` to exercise the
  // removed (owner-hidden vs mod-removed) branches.
  const appListing =
    overrides.appListing !== undefined
      ? overrides.appListing
      : {
          name: 'Off App',
          externalUrl: 'https://example.com/app',
          category: 'utility',
          contentRating: 'g',
          status,
        };
  return {
    id: 'o1',
    appListingId: 'listing-1',
    slug: 'off-app',
    status,
    submittedAt: new Date('2026-01-01T00:00:00Z'),
    reviewedAt: new Date('2026-01-02T00:00:00Z'),
    rejectionReason: null,
    approvalNotes: null,
    changelog: null,
    lastModerationAction: null,
    ...overrides,
    appListing,
  };
}

/** A LIVE off-site listing (approved request + approved listing). */
const live = (over: Partial<OffsiteSubmission> = {}) =>
  makeOffsite({ id: 'a', slug: 'live-off', appListingId: 'l-a', status: 'approved', ...over });

/** A removed listing whose LAST event was the owner's own unpublish. */
const ownerHidden = () =>
  makeOffsite({
    id: 'h',
    slug: 'hidden-off',
    appListingId: 'l-h',
    status: 'approved', // the publish request stays approved after an unpublish
    appListing: {
      name: 'Hidden App',
      externalUrl: 'https://example.com/hidden',
      category: 'utility',
      contentRating: 'g',
      status: 'removed',
    },
    lastModerationAction: 'owner-unpublish',
  });

/** A removed listing taken down by a MODERATOR (last event = delist). */
const modRemoved = () =>
  makeOffsite({
    id: 'm',
    slug: 'gone-off',
    appListingId: 'l-m',
    status: 'approved',
    appListing: {
      name: 'Gone App',
      externalUrl: 'https://example.com/gone',
      category: 'utility',
      contentRating: 'g',
      status: 'removed',
    },
    lastModerationAction: 'delist',
  });

const oneOfEach = (): OffsiteSubmission[] => [
  live(),
  makeOffsite({ id: 'b', slug: 'pending-off', appListingId: 'l-b', status: 'pending', reviewedAt: null }),
  makeOffsite({ id: 'c', slug: 'rejected-off', appListingId: null, status: 'rejected' }),
  makeOffsite({ id: 'd', slug: 'withdrawn-off', appListingId: null, status: 'withdrawn' }),
];

describe('OffsiteSubmissionsList — status sections', () => {
  test('groups off-site submissions into the four status sections', async () => {
    renderWithProviders(
      <OffsiteSubmissionsList submissions={oneOfEach()} onWithdraw={vi.fn()} withdrawing={false} />
    );
    await expect
      .element(page.getByTestId('apps-offsite-submissions-section-live'))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-offsite-submissions-section-pending'))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-offsite-submissions-section-rejected'))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-offsite-submissions-section-withdrawn'))
      .toBeInTheDocument();
  });

  test('Live + Pending render expanded; Rejected + Withdrawn are collapsed by default', async () => {
    renderWithProviders(
      <OffsiteSubmissionsList submissions={oneOfEach()} onWithdraw={vi.fn()} withdrawing={false} />
    );
    // Expanded sections show their rows.
    await expect.element(page.getByText('live-off', { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText('pending-off', { exact: false })).toBeInTheDocument();
    // Collapsed sections hide their rows until toggled.
    expect(page.getByText('rejected-off', { exact: false }).elements()).toHaveLength(0);
    expect(page.getByText('withdrawn-off', { exact: false }).elements()).toHaveLength(0);

    const withdrawnToggle = page.getByTestId('apps-offsite-submissions-section-withdrawn-toggle');
    expect(withdrawnToggle.element().getAttribute('aria-expanded')).toBe('false');
    await withdrawnToggle.click();
    await expect.element(page.getByText('withdrawn-off', { exact: false })).toBeInTheDocument();
    expect(withdrawnToggle.element().getAttribute('aria-expanded')).toBe('true');
    // The Rejected section stays collapsed (independent toggle).
    expect(page.getByText('rejected-off', { exact: false }).elements()).toHaveLength(0);
  });

  test('empty sections are not rendered (only-pending → no other sections)', async () => {
    renderWithProviders(
      <OffsiteSubmissionsList
        submissions={[
          makeOffsite({ id: 'b', slug: 'pending-off', appListingId: 'l-b', status: 'pending', reviewedAt: null }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    await expect
      .element(page.getByTestId('apps-offsite-submissions-section-pending'))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-submissions-section-live').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-submissions-section-rejected').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-submissions-section-withdrawn').elements()).toHaveLength(0);
  });

  test('an editable row renders an Edit link to the submit wizard in edit mode', async () => {
    renderWithProviders(
      <OffsiteSubmissionsList
        submissions={[live()]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    const editLink = page.getByTestId('apps-offsite-edit-live-off');
    await expect.element(editLink).toBeInTheDocument();
    // The Edit affordance is a LINK to /apps/submit?edit=<appListingId> (not a modal).
    expect(editLink.element().getAttribute('href')).toBe('/apps/submit?edit=l-a');
  });

  test('the text filter narrows rows within their sections', async () => {
    renderWithProviders(
      <OffsiteSubmissionsList
        submissions={[
          live({ id: 'a', slug: 'alpha-off', appListingId: 'l-a' }),
          live({ id: 'b', slug: 'bravo-off', appListingId: 'l-b' }),
        ]}
        onWithdraw={vi.fn()}
        withdrawing={false}
      />
    );
    await expect.element(page.getByText('alpha-off', { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText('bravo-off', { exact: false })).toBeInTheDocument();
    await page.getByTestId('apps-offsite-submissions-filter').fill('bravo');
    await expect.element(page.getByText('bravo-off', { exact: false })).toBeInTheDocument();
    expect(page.getByText('alpha-off', { exact: false }).elements()).toHaveLength(0);
  });
});

describe('OffsiteSubmissionsList — owner unpublish (live listing)', () => {
  test('a live listing shows Unpublish; the confirm gate fires unpublishOwnListing with the listing id', async () => {
    renderWithProviders(
      <OffsiteSubmissionsList submissions={[live()]} onWithdraw={vi.fn()} withdrawing={false} />
    );
    // The row Unpublish button opens a confirm modal — it does NOT fire the mutation.
    await page.getByTestId('apps-offsite-unpublish-live-off').click();
    expect(mocks.mutate).not.toHaveBeenCalled();

    // Confirming in the modal fires the mutation with the right listing id (no reason).
    await page.getByTestId('apps-offsite-unpublish-confirm').click();
    expect(mocks.mutate).toHaveBeenCalledWith('unpublish', {
      appListingId: 'l-a',
      reason: undefined,
    });
    // On success it invalidates the my-submissions query so the list refetches.
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  test('an optional reason is forwarded (trimmed) when provided', async () => {
    renderWithProviders(
      <OffsiteSubmissionsList submissions={[live()]} onWithdraw={vi.fn()} withdrawing={false} />
    );
    await page.getByTestId('apps-offsite-unpublish-live-off').click();
    await page.getByTestId('apps-offsite-unpublish-reason').fill('  taking a break  ');
    await page.getByTestId('apps-offsite-unpublish-confirm').click();
    expect(mocks.mutate).toHaveBeenCalledWith('unpublish', {
      appListingId: 'l-a',
      reason: 'taking a break',
    });
  });

  test('a live listing does NOT show Republish or the mod-removed state', async () => {
    renderWithProviders(
      <OffsiteSubmissionsList submissions={[live()]} onWithdraw={vi.fn()} withdrawing={false} />
    );
    await expect.element(page.getByTestId('apps-offsite-unpublish-live-off')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-republish-live-off').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-mod-removed-live-off').elements()).toHaveLength(0);
  });
});

describe('OffsiteSubmissionsList — owner republish vs moderator takedown (load-bearing)', () => {
  test('an OWNER-hidden listing shows Republish → fires republishOwnListing (no Unpublish)', async () => {
    renderWithProviders(
      <OffsiteSubmissionsList submissions={[ownerHidden()]} onWithdraw={vi.fn()} withdrawing={false} />
    );
    const republish = page.getByTestId('apps-offsite-republish-hidden-off');
    await expect.element(republish).toBeInTheDocument();
    // No mod-removed state, and no Unpublish (it's already hidden).
    expect(page.getByTestId('apps-offsite-mod-removed-hidden-off').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-unpublish-hidden-off').elements()).toHaveLength(0);

    await republish.click();
    expect(mocks.mutate).toHaveBeenCalledWith('republish', { appListingId: 'l-h' });
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  test('a MODERATOR-removed listing shows "Removed by a moderator" and NO republish button', async () => {
    renderWithProviders(
      <OffsiteSubmissionsList submissions={[modRemoved()]} onWithdraw={vi.fn()} withdrawing={false} />
    );
    await expect.element(page.getByTestId('apps-offsite-mod-removed-gone-off')).toBeInTheDocument();
    // The load-bearing safety guard: NO republish affordance on a mod takedown.
    expect(page.getByTestId('apps-offsite-republish-gone-off').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-unpublish-gone-off').elements()).toHaveLength(0);
  });
});

describe('OffsiteSubmissionsList — moderation history modal', () => {
  test('the History button opens the timeline with actions + verbatim reasons', async () => {
    mocks.historyItems = [
      {
        id: 'e2',
        action: 'delist',
        reason: 'Reported for spam',
        createdAt: new Date('2026-02-02T00:00:00Z'),
      },
      {
        id: 'e1',
        action: 'owner-unpublish',
        reason: null,
        createdAt: new Date('2026-02-01T00:00:00Z'),
      },
    ];
    renderWithProviders(
      <OffsiteSubmissionsList submissions={[modRemoved()]} onWithdraw={vi.fn()} withdrawing={false} />
    );
    await page.getByTestId('apps-offsite-history-gone-off').click();
    // The timeline renders both events (verbatim reason + the action chip labels).
    await expect.element(page.getByText('Reported for spam')).toBeInTheDocument();
    await expect.element(page.getByText('Delisted')).toBeInTheDocument();
    await expect.element(page.getByText('Unpublished by you')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-history-entry').elements().length).toBeGreaterThanOrEqual(2);
  });

  test('an empty history shows the empty-state copy', async () => {
    // History only renders on a removed/hidden listing now (a pristine live app shows
    // no History button), so exercise the empty-state on an owner-hidden listing whose
    // history query returns [].
    mocks.historyItems = [];
    renderWithProviders(
      <OffsiteSubmissionsList submissions={[ownerHidden()]} onWithdraw={vi.fn()} withdrawing={false} />
    );
    await page.getByTestId('apps-offsite-history-hidden-off').click();
    await expect.element(page.getByTestId('apps-offsite-history-empty')).toBeInTheDocument();
  });
});
