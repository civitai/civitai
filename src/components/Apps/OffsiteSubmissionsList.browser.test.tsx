import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * /apps/my-submissions OFF-SITE list — status-section restructure (UX pass).
 * The offsite (external-link) list now renders as the same four status SECTIONS as
 * the onsite list: Live + Pending (always expanded) and Rejected + Withdrawn
 * (default-collapsed `Collapse`, revealed by their toggle). Asserted via the stable
 * `apps-offsite-submissions-section-*` testids.
 *
 * The list transitively imports `MySubmissionsList` (for `ReviewerNotesButton`),
 * which pulls in the analytics inline stat → `~/utils/trpc`, mocked so this stays
 * network-free. Per the documented gotcha, the wholesale `~/utils/trpc` mock
 * includes `setTrpcBatchingEnabled` (a graph-reachable module imports it). The Edit
 * affordance is now a plain LINK to `/apps/submit?edit=<id>` (the modal was
 * consolidated into the submit wizard) — no per-row trpc surface to stub.
 */

vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      getMyAppAnalytics: {
        useQuery: () => ({ data: { runs: { count: 0 }, engagement: { activeUsers: 0 } }, isLoading: false }),
      },
    },
  },
  setTrpcBatchingEnabled: vi.fn(),
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

import type { OffsiteSubmission } from './OffsiteSubmissionsList';
const { OffsiteSubmissionsList } = await import('./OffsiteSubmissionsList');

function makeOffsite(overrides: Partial<OffsiteSubmission>): OffsiteSubmission {
  return {
    id: 'o1',
    appListingId: 'listing-1',
    slug: 'off-app',
    status: 'approved',
    submittedAt: new Date('2026-01-01T00:00:00Z'),
    reviewedAt: new Date('2026-01-02T00:00:00Z'),
    rejectionReason: null,
    approvalNotes: null,
    changelog: null,
    appListing: {
      name: 'Off App',
      externalUrl: 'https://example.com/app',
      category: 'utility',
      contentRating: 'g',
    },
    ...overrides,
  };
}

const oneOfEach = (): OffsiteSubmission[] => [
  makeOffsite({ id: 'a', slug: 'live-off', appListingId: 'l-a', status: 'approved' }),
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
        submissions={[
          makeOffsite({ id: 'a', slug: 'live-off', appListingId: 'l-a', status: 'approved' }),
        ]}
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
          makeOffsite({ id: 'a', slug: 'alpha-off', appListingId: 'l-a', status: 'approved' }),
          makeOffsite({ id: 'b', slug: 'bravo-off', appListingId: 'l-b', status: 'approved' }),
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
