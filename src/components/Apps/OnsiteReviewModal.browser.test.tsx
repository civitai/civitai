import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * On-site (App Block) review modal — browser-mode render test (report-only in
 * Tekton). The modal was extracted from `src/pages/apps/review.tsx` to
 * `OnsiteReviewModal.tsx` (mirrors #3154) so it is importable WITHOUT the page's
 * `getServerSideProps` server graph — this suite is the coverage that extraction
 * unlocks. Asserts:
 *  - onsite-specific visibility (Forgejo link + the mod Review-preview panel +
 *    the structured manifest render);
 *  - Approve FIRES `blocks.approveRequest` with the request id;
 *  - the reject reason gate (disabled < 3 chars) AND that Reject FIRES
 *    `blocks.rejectRequest` with `{ publishRequestId, rejectionReason }`;
 *  - a read-only (approved) selection surfaces the mod feedback and shows NO
 *    approve/reject actions.
 */

const ONSITE_PENDING = {
  id: 'onsite-req-1',
  appBlockId: null as string | null,
  slug: 'my-onsite-block',
  version: '1.2.0',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  bundleSizeBytes: '2048',
  bundleSha256: 'abcdef0123456789abcdef0123456789',
  manifest: {
    name: 'My Onsite Block',
    blockId: 'blk_1',
    version: '1.2.0',
    scopes: ['user:read'],
    targets: [{ slotId: 'model.sidebar_top', priority: 10 }],
    iframe: { src: 'https://example.com/block', sandbox: 'allow-scripts' },
  },
  fileSummary: {
    files: [{ path: 'index.js', sha256: 'x', sizeBytes: 10 }],
    added: ['index.js'],
    removed: [],
    changed: [],
  },
  manifestDiffSummary: { kind: 'first-version', fields: ['name'] },
  reviewRepoUrl: 'https://forgejo.example/repo',
  pushCommitUrl: null as string | null,
  submittedBy: { id: 7, username: 'dev-user', image: null },
};

const ONSITE_APPROVED = {
  ...ONSITE_PENDING,
  id: 'onsite-req-2',
  slug: 'approved-block',
  reviewedAt: new Date('2026-01-02T00:00:00Z'),
  approvalNotes: 'looks good, shipping it',
  reviewedBy: { id: 99, username: 'mod-user', image: null },
};

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
  errorMode: false,
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
  const inert = { invalidate: mocks.invalidate };
  const utils = {
    blocks: {
      listPendingRequests: inert,
      listApprovedRequests: inert,
      listRejectedRequests: inert,
      getReviewStatus: inert,
      listActivePreviews: inert,
      getMarketplaceMeta: inert,
      getFeaturedBlocks: inert,
      listAvailable: inert,
    },
  };
  return {
    trpc: {
      useUtils: () => utils,
      blocks: {
        approveRequest: { useMutation: mutation('approve') },
        rejectRequest: { useMutation: mutation('reject') },
        // Sub-panel queries the modal mounts (Review-preview / Screenshots / Code
        // diff) — kept network-free with empty/no-op state.
        getReviewStatus: {
          useQuery: () => ({ data: undefined, isLoading: false, error: null }),
        },
        previewRequest: { useMutation: mutation('preview') },
        teardownPreview: { useMutation: mutation('teardown') },
        getPublishRequestScreenshots: {
          useQuery: () => ({ data: { items: [] }, isLoading: false, error: null }),
        },
        getPublishRequestDiff: {
          useQuery: () => ({ data: undefined, isLoading: false, error: null }),
        },
        // Only reached by the (approved + appBlockId) curation panel — defined so
        // the mock is complete if a future test exercises that branch.
        getMarketplaceMeta: {
          useQuery: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
        },
        setMarketplaceMeta: { useMutation: mutation('setMeta') },
      },
    },
  };
});

const { OnsiteReviewModal } = await import('./OnsiteReviewModal');

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.mutate.mockClear();
  mocks.errorMode = false;
  showError.mockClear();
});

describe('OnsiteReviewModal — onsite-specific contract', () => {
  test('a pending selection renders the Forgejo link, the mod Review-preview panel, and the structured manifest', async () => {
    renderWithProviders(
      <OnsiteReviewModal selection={{ request: ONSITE_PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    // The on-site code-review affordance (off-site has no bundle/code).
    await expect.element(page.getByText('View code in Forgejo')).toBeInTheDocument();
    // The mod Review-preview sandbox panel — on-site pending only.
    await expect.element(page.getByText('Review preview')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Start preview' })).toBeInTheDocument();
    // Structured manifest render (scopes + slot targets), not a raw JSON dump.
    await expect.element(page.getByText('JWT scopes (1)')).toBeInTheDocument();
    await expect.element(page.getByText('model.sidebar_top')).toBeInTheDocument();
    // A first-version submission shows the full-manifest note (no diff).
    await expect
      .element(page.getByText('First version — full manifest below.'))
      .toBeInTheDocument();
    // Both action entry points are present on a pending request.
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Reject…' })).toBeInTheDocument();
  });
});

describe('OnsiteReviewModal — onsite approve fires the mutation', () => {
  test('clicking Approve + build fires blocks.approveRequest with the request id', async () => {
    renderWithProviders(
      <OnsiteReviewModal selection={{ request: ONSITE_PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(mocks.mutate).toHaveBeenCalledWith(
      'approve',
      expect.objectContaining({ publishRequestId: 'onsite-req-1' })
    );
  });

  test('an approve mutation error surfaces via showErrorNotification', async () => {
    mocks.errorMode = true;
    renderWithProviders(
      <OnsiteReviewModal selection={{ request: ONSITE_PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(showError).toHaveBeenCalledWith(expect.objectContaining({ title: 'Approve failed' }));
  });
});

describe('OnsiteReviewModal — onsite reject: reason gate + fired mutation', () => {
  test('the reject confirm is disabled under the 3-char reason floor, then fires blocks.rejectRequest with the trimmed reason', async () => {
    renderWithProviders(
      <OnsiteReviewModal selection={{ request: ONSITE_PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    // No rejection textarea until "Reject…" is clicked.
    expect(page.getByTestId('apps-review-reject-reason').elements()).toHaveLength(0);
    await page.getByRole('button', { name: 'Reject…' }).click();
    await expect.element(page.getByTestId('apps-review-reject-reason')).toBeInTheDocument();

    const confirm = page.getByTestId('apps-review-reject-confirm');
    // Empty reason → disabled.
    await expect.element(confirm).toBeDisabled();
    // A too-short reason (2 < OFFSITE_MOD_REASON_MIN=3) → still disabled.
    await page.getByTestId('apps-review-reject-reason').fill('no');
    await expect.element(confirm).toBeDisabled();
    // Whitespace-only padding does NOT satisfy the gate (trimmed length counts).
    await page.getByTestId('apps-review-reject-reason').fill('  a  ');
    await expect.element(confirm).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();

    // A reason at/above the 3-char minimum → enabled → fires with the TRIMMED reason.
    await page.getByTestId('apps-review-reject-reason').fill('needs changes');
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    expect(mocks.mutate).toHaveBeenCalledWith('reject', {
      publishRequestId: 'onsite-req-1',
      rejectionReason: 'needs changes',
    });
  });
});

describe('OnsiteReviewModal — read-only (approved) posture', () => {
  test('an approved selection surfaces the mod feedback and shows NO approve/reject actions', async () => {
    renderWithProviders(
      <OnsiteReviewModal
        selection={{ request: ONSITE_APPROVED, mode: 'approved' }}
        onClose={vi.fn()}
      />
    );
    // The reviewer + notes are surfaced.
    await expect.element(page.getByText('Approved by @mod-user')).toBeInTheDocument();
    await expect.element(page.getByText('looks good, shipping it')).toBeInTheDocument();
    // Read-only → neither action control renders, and no Review-preview panel.
    expect(page.getByRole('button', { name: 'Approve + build' }).elements()).toHaveLength(0);
    expect(page.getByRole('button', { name: 'Reject…' }).elements()).toHaveLength(0);
    expect(page.getByText('Review preview').elements()).toHaveLength(0);
  });
});
