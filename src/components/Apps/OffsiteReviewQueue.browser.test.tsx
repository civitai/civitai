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

const DEFAULT_ASSETS = {
  listingId: 'listing-1',
  iconId: 10,
  coverId: 11,
  iconNsfwLevel: 1,
  coverNsfwLevel: 1,
  // Icon/cover PG (1); a screenshot at R (4) → derived rating 'r' > declared 'g'.
  screenshots: [{ imageId: 12, nsfwLevel: 4, scanStatus: 'scanned' as const }],
  iconScanStatus: 'scanned' as const,
  coverScanStatus: 'scanned' as const,
  hasBlockedAsset: false,
  hasPendingScan: false,
};

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  approveMutate: vi.fn(),
  rejectMutate: vi.fn(),
  // Mutable so a test can inject a blocked / pending scan state (Item 1).
  assetsData: { current: null as unknown },
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));
// The modal body renders the listing preview (AppListingCard + AppListingDetailBody),
// which reads useCurrentUser — boundary-stub it (null user is fine).
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

// Only the `trpc` client itself is overridden — the rest of `~/utils/trpc`'s real exports
// (setTrpcBatchingEnabled, trpcVanilla, queryClient, ...) are kept via importOriginal so any
// transitively-imported consumer elsewhere in the tree (e.g. session/provider chains) still
// gets a real binding instead of the whack-a-mole of hand-naming every export they touch.
// Without the spread, a LATER PR adding an export to `~/utils/trpc` breaks this file's ESM
// link ("does not provide an export named X") and the whole file collects 0 tests.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/trpc')>();
  return {
    ...actual,
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
            // HIGHER than the declared 'g' (mismatch case). Scan state is configurable
            // per test via mocks.assetsData.current.
            data: mocks.assetsData.current,
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
        // Listing-preview projection — undefined data → the section falls back to the
        // placeholder-art layout preview (these tests assert checklist/scan behaviour).
        getListingPreviewForReview: {
          useQuery: () => ({ data: undefined, isLoading: false, error: null }),
        },
      },
    },
  };
});

const { OffsiteReviewQueue, OffsiteReviewModal } = await import('./OffsiteReviewQueue');

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.approveMutate.mockClear();
  mocks.rejectMutate.mockClear();
  mocks.assetsData.current = { ...DEFAULT_ASSETS };
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

describe('OffsiteReviewModal — scan-clean dimension (Item 1)', () => {
  test('a BLOCKED asset shows the "blocked media" alert explaining approve will be rejected', async () => {
    mocks.assetsData.current = {
      ...DEFAULT_ASSETS,
      iconScanStatus: 'blocked',
      hasBlockedAsset: true,
    };
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    const alert = page.getByTestId('apps-offsite-assets-scan-blocked');
    await expect.element(alert).toBeInTheDocument();
    await expect.element(alert).toHaveTextContent(/Blocked media: icon/i);
  });

  test('a still-PENDING scan shows the "still scanning" advisory (no blocked alert)', async () => {
    mocks.assetsData.current = {
      ...DEFAULT_ASSETS,
      coverScanStatus: 'pending',
      hasPendingScan: true,
    };
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await expect
      .element(page.getByTestId('apps-offsite-assets-scan-pending'))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-assets-scan-blocked').elements()).toHaveLength(0);
  });

  test('all-scanned assets show NEITHER the blocked nor the pending scan alert', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    expect(page.getByTestId('apps-offsite-assets-scan-blocked').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-assets-scan-pending').elements()).toHaveLength(0);
  });

  // Audit 🟡 — the Approve entry button is DISABLED when the scan-clean gate would
  // reject it (blocked/pending), so a mod click doesn't just eat a server BAD_REQUEST.
  test('the Approve button is DISABLED when an asset is blocked', async () => {
    mocks.assetsData.current = {
      ...DEFAULT_ASSETS,
      iconScanStatus: 'blocked',
      hasBlockedAsset: true,
    };
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await expect
      .element(page.getByTestId('apps-offsite-approve-open'))
      .toBeDisabled();
  });

  test('the Approve button is DISABLED while an asset is still scanning', async () => {
    mocks.assetsData.current = {
      ...DEFAULT_ASSETS,
      coverScanStatus: 'pending',
      hasPendingScan: true,
    };
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await expect
      .element(page.getByTestId('apps-offsite-approve-open'))
      .toBeDisabled();
  });

  test('the Approve button is ENABLED when every asset is scan-clean', async () => {
    renderWithProviders(<OffsiteReviewQueue />);
    await page.getByRole('button', { name: 'Review' }).click();
    await expect
      .element(page.getByTestId('apps-offsite-approve-open'))
      .not.toBeDisabled();
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
    // #3412 added the listing-preview detail pane (`apps-listing-preview-detail`), which
    // renders its OWN content-rating badge — so a bare exact 'g' now matches 2 elements and
    // the strict query throws. Scope to the Content-rating FIELD GROUP this test is about,
    // asserting its full text (label + badge value + qualifier). That still fails if the
    // badge value is wrong or missing, rather than being satisfied by the preview's copy.
    const ratingLabel = page.getByText('Content rating', { exact: true });
    await expect.element(ratingLabel).toBeInTheDocument();
    expect(ratingLabel.element().parentElement?.textContent).toBe('Content ratinggdeclared');
  });
});

// History-tab parity: opening an offsite row from Approved/Rejected passes readOnly,
// which HIDES the Approve.../Reject... action buttons (an already-decided request would
// only error NOT_PENDING server-side) while keeping the detail view — matching the
// on-site history read-only posture. Purely presentational (no handler change).
describe('OffsiteReviewModal — readOnly (history) posture hides the action buttons', () => {
  test('readOnly HIDES both entry action buttons but keeps the content detail view', async () => {
    renderWithProviders(<OffsiteReviewModal request={OFFSITE_ROW} onClose={vi.fn()} readOnly />);
    // Detail still renders — the external URL + the content checklist.
    await expect
      .element(page.getByText('URL is https and opens externally'))
      .toBeInTheDocument();
    await expect.element(page.getByText('Icon present')).toBeInTheDocument();
    // But NEITHER Approve… nor Reject… action button renders in read-only mode.
    expect(page.getByTestId('apps-offsite-approve-open').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-reject-open').elements()).toHaveLength(0);
  });

  test('default (readOnly omitted) still renders the Approve…/Reject… buttons', async () => {
    renderWithProviders(<OffsiteReviewModal request={OFFSITE_ROW} onClose={vi.fn()} />);
    await expect.element(page.getByTestId('apps-offsite-approve-open')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-reject-open')).toBeInTheDocument();
  });
});

// On-site listing-MEDIA revision (kind: 'onsite') — the same listing modal reviews
// it, but it renders kind-aware: a "listing media" header (NOT "external app"), NO
// external URL, NO connect panel, the shadow-asset content checklist, and a
// cap-at-app-rating review (media must not exceed the app's rating). Report-only.
describe('OffsiteReviewModal — on-site listing-media revision (kind: onsite)', () => {
  const ONSITE_MEDIA_ROW = {
    id: 'lmr-1',
    kind: 'onsite' as const,
    appListingId: 'listing-1',
    slug: 'onsite-media-app',
    status: 'pending',
    submittedAt: new Date('2026-02-01T00:00:00Z'),
    changelog: 'refreshed the screenshots',
    appListing: {
      name: 'On-site Media App',
      // An on-site listing-media revision has NO external URL and NO connect client.
      externalUrl: null,
      category: 'utility',
      contentRating: 'g',
      connectClientId: null,
    },
    submittedBy: { id: 42, username: 'author-dev', image: null },
  };

  test('renders the listing-media header, the asset checklist, and NO URL / connect panel', async () => {
    renderWithProviders(<OffsiteReviewModal request={ONSITE_MEDIA_ROW} onClose={vi.fn()} />);
    // Kind-aware header — the "listing media" badge, not "external".
    await expect.element(page.getByTestId('apps-offsite-kind-badge')).toHaveTextContent(
      'listing media'
    );
    expect(page.getByText('external', { exact: true }).elements()).toHaveLength(0);
    // The on-site explainer note renders.
    await expect.element(page.getByTestId('apps-offsite-onsite-note')).toBeInTheDocument();
    // The shadow-asset content checklist is present (asset-presence items).
    await expect.element(page.getByText('Icon present')).toBeInTheDocument();
    await expect.element(page.getByText('Cover present')).toBeInTheDocument();
    // No external URL row is rendered (null externalUrl degrades gracefully).
    expect(page.getByText('URL is https and opens externally').elements()).toHaveLength(0);
    // No code-review items and no connect scopes panel.
    expect(page.getByText('Code diff reviewed').elements()).toHaveLength(0);
    expect(page.getByTestId('connect-scopes-panel').elements()).toHaveLength(0);
    // The app-rating cap label surfaces (vs "declared" for offsite).
    await expect.element(page.getByText('app rating (cap)', { exact: true })).toBeInTheDocument();
  });

  test('flags media rated higher than the app rating as a cap violation (reject reason)', async () => {
    // Assets derive 'r' (screenshot @ level 4) vs the app rating 'g' → cap exceeded.
    renderWithProviders(<OffsiteReviewModal request={ONSITE_MEDIA_ROW} onClose={vi.fn()} />);
    const mismatch = page.getByTestId('apps-offsite-rating-mismatch');
    await expect.element(mismatch).toBeInTheDocument();
    // The cap-rule phrase now also appears in the on-site explainer note, so a bare
    // getByText matches two elements (strict-mode violation). Scope the reject-reason
    // assertion to the mismatch callout itself.
    await expect.element(mismatch).toHaveTextContent('must not exceed the app’s rating');
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
