import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { formatDate } from '~/utils/date-helpers';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 P3a — /apps/review off-site (external-link) queue. Browser-mode render test
 * (report-only in Tekton): a pending off-site row renders in the kind-aware queue,
 * and opening it shows the CONTENT-ONLY checklist (https / asset presence, NO code
 * items) + the external URL + Approve/Reject.
 */

const OFFSITE_ROW = {
  id: 'req-1',
  appListingId: 'listing-1',
  slug: 'ci-ext-app',
  status: 'pending',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  changelog: 'a note for the reviewer',
  appListing: {
    name: 'CI External App',
    externalUrl: 'https://example.com/app',
    category: 'utility',
    contentRating: 'g',
  },
  submittedBy: { id: 42, username: 'author-dev', image: null },
};

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  approveMutate: vi.fn(),
  rejectMutate: vi.fn(),
}));

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
          listPendingRequests: { invalidate: mocks.invalidate },
          listApprovedRequests: { invalidate: mocks.invalidate },
          listRejectedRequests: { invalidate: mocks.invalidate },
        },
      }),
      appListings: {
        listPendingRequests: {
          useQuery: () => ({
            data: { items: [OFFSITE_ROW], nextCursor: null },
            isLoading: false,
            error: null,
          }),
        },
        getAssets: {
          useQuery: () => ({
            // Icon/cover PG (1); a screenshot at R (4) → derived rating 'r', which is
            // HIGHER than the declared 'g' (mismatch case).
            data: {
              listingId: 'listing-1',
              iconId: 10,
              coverId: 11,
              iconNsfwLevel: 1,
              coverNsfwLevel: 1,
              screenshots: [{ imageId: 12, nsfwLevel: 4 }],
            },
            isLoading: false,
            error: null,
          }),
        },
        approveExternalRequest: {
          useMutation: () => ({
            mutate: mocks.approveMutate,
            mutateAsync: vi.fn(),
            isPending: false,
          }),
        },
        rejectExternalRequest: {
          useMutation: () => ({
            mutate: mocks.rejectMutate,
            mutateAsync: vi.fn(),
            isPending: false,
          }),
        },
      },
    },
  };
});

const { OffsiteReviewQueue } = await import('./OffsiteReviewQueue');

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.approveMutate.mockClear();
  mocks.rejectMutate.mockClear();
});

describe('OffsiteReviewQueue — kind-aware review row', () => {
  test('renders a pending off-site row', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await expect.element(page.getByText('ci-ext-app')).toBeInTheDocument();
    await expect.element(page.getByText('External-link submissions')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Review' })).toBeInTheDocument();
  });

  test('opening a row shows the content-only checklist + external URL + Approve/Reject', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    // Content checklist items — the off-site (content-only) set.
    await expect
      .element(page.getByText('URL is https and opens externally'))
      .toBeInTheDocument();
    await expect.element(page.getByText('Icon present')).toBeInTheDocument();
    // NO on-site code items.
    expect(page.getByText('Code diff reviewed').elements()).toHaveLength(0);
    // The two ENTRY actions present (approve is now gated behind its own click).
    await expect.element(page.getByTestId('apps-offsite-approve-open')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-reject-open')).toBeInTheDocument();
  });
});

describe('OffsiteReviewModal — approve-notes gating, friendly date, field labels', () => {
  test('the approval-notes textarea is NOT shown until "Approve…" is clicked, then a confirm Approve appears', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();

    // View mode: only the two entry buttons — NO approval-notes textarea yet.
    await expect.element(page.getByTestId('apps-offsite-approve-open')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-approve-notes').elements()).toHaveLength(0);

    // Clicking "Approve…" reveals the notes textarea + a confirm Approve button.
    await page.getByTestId('apps-offsite-approve-open').click();
    await expect.element(page.getByTestId('apps-offsite-approve-notes')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-approve-confirm')).toBeInTheDocument();
    // The entry buttons are gone (replaced by Cancel / Approve).
    expect(page.getByTestId('apps-offsite-approve-open').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-reject-open').elements()).toHaveLength(0);
  });

  test('the Reject… flow still reveals the rejection-reason textarea + confirm', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    // No rejection textarea until Reject… is clicked.
    expect(page.getByTestId('apps-offsite-reject-reason').elements()).toHaveLength(0);
    await page.getByTestId('apps-offsite-reject-open').click();
    await expect.element(page.getByTestId('apps-offsite-reject-reason')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-reject-confirm')).toBeInTheDocument();
  });

  // Bug 1: the Reject confirm was gated on a silent 10-char minimum (every other
  // mod-reason field uses the shared 3-char `OFFSITE_MOD_REASON_MIN`). Gate is now
  // unified on that minimum with inline feedback — assert the disabled→enabled
  // transition (also catches a genuine wiring defect if the gate never opens).
  test('Reject confirm is disabled until a ≥min-length reason is typed', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-reject-open').click();

    const confirm = page.getByTestId('apps-offsite-reject-confirm');
    // Empty reason → disabled.
    await expect.element(confirm).toBeDisabled();

    // A too-short reason (2 < OFFSITE_MOD_REASON_MIN=3) → still disabled.
    await page.getByTestId('apps-offsite-reject-reason').fill('no');
    await expect.element(confirm).toBeDisabled();

    // A reason at/above the 3-char minimum → enabled.
    await page.getByTestId('apps-offsite-reject-reason').fill('needs a real reason');
    await expect.element(confirm).toBeEnabled();

    // Whitespace-only padding does NOT satisfy the gate (trimmed length counts).
    await page.getByTestId('apps-offsite-reject-reason').fill('  a  ');
    await expect.element(confirm).toBeDisabled();
  });

  // Beyond the GATE (disabled→enabled), lock that a valid reject actually FIRES
  // the reject mutation with the trimmed reason + the request id — no prior test
  // asserted the fired offsite reject mutation (only the gate).
  test('Reject with a ≥min-length reason FIRES rejectExternalRequest with {publishRequestId, rejectionReason}', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-reject-open').click();

    await page.getByTestId('apps-offsite-reject-reason').fill('needs a real reason');
    const confirm = page.getByTestId('apps-offsite-reject-confirm');
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    expect(mocks.rejectMutate).toHaveBeenCalledWith({
      publishRequestId: 'req-1',
      rejectionReason: 'needs a real reason',
    });
  });

  // The disabled-reason Tooltip wraps the disabled Button in a Box so it still
  // fires on hover (a native disabled <button> emits no pointer events). Assert
  // the hint text surfaces while the gate is closed.
  test('hovering the disabled Reject confirm surfaces the reason hint', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-reject-open').click();

    const confirm = page.getByTestId('apps-offsite-reject-confirm');
    await expect.element(confirm).toBeDisabled();
    await confirm.hover();
    await expect
      .element(page.getByText('Enter a reason — at least 3 characters.'))
      .toBeInTheDocument();
  });

  test('the submitted timestamp renders as "Month D, YYYY" (no time-of-day)', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    // Self-consistent with the component (same helper) → TZ-agnostic.
    const expected = formatDate(OFFSITE_ROW.submittedAt, 'MMMM D, YYYY');
    // Present in the queue row's "Submitted" column (and again in the modal once open).
    await expect.element(page.getByText(expected, { exact: false }).first()).toBeInTheDocument();
    // The old toLocaleString form carried a clock time — none should remain.
    expect(page.getByText(/\d{1,2}:\d\d/).elements()).toHaveLength(0);
  });

  test('the modal labels the Category and Content-rating fields', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await expect.element(page.getByText('Category', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('Content rating', { exact: true })).toBeInTheDocument();
    // The badge values they label are still rendered.
    await expect.element(page.getByText('utility', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('g', { exact: true })).toBeInTheDocument();
  });
});

describe('OffsiteReviewModal — content-rating derive + mod override', () => {
  test('surfaces the DERIVED rating and FLAGS it as higher than the declared rating', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    // Derived from the assets (max R) → 'r', shown alongside the declared 'g'.
    await expect
      .element(page.getByTestId('apps-offsite-derived-rating'))
      .toHaveTextContent('r');
    // Assets more mature than declared → the mismatch warning renders.
    await expect
      .element(page.getByTestId('apps-offsite-rating-mismatch'))
      .toBeInTheDocument();
  });

  test('the approve rating Select defaults to the derived value and approve passes it', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await page.getByTestId('apps-offsite-approve-open').click();
    // The Select is present (defaulting to the derived rating), and confirming approve
    // forwards the chosen rating to the mutation.
    await expect.element(page.getByTestId('apps-offsite-approve-rating')).toBeInTheDocument();
    await page.getByTestId('apps-offsite-approve-confirm').click();
    expect(mocks.approveMutate).toHaveBeenCalledWith(
      expect.objectContaining({ publishRequestId: 'req-1', contentRating: 'r' })
    );
  });
});
