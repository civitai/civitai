import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * `ReviewDetailView` — the per-submission review PAGE body (`/apps/review/<id>`),
 * factored out of the page module so it is browser-testable without the server
 * graph. This is the page-specific action + a11y layer (Phase 2.3):
 *  - the approve/reject controls render in a STICKY bottom bar (not inline);
 *  - focus moves to the main review region on mount (a page has no focus trap);
 *  - an aria-live region announces mutation-status transitions;
 *  - a route-leave guard registers while an approve/reject is in flight.
 * Drives the real click → mutation → redirect path, not just a mount.
 */

const PENDING = {
  id: 'req-1',
  appBlockId: null as string | null,
  slug: 'my-block',
  version: '1.2.0',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  bundleSizeBytes: '2048',
  bundleSha256: 'abc',
  manifest: {
    name: 'My Block',
    blockId: 'blk_1',
    version: '1.2.0',
    scopes: ['user:read'],
    targets: [{ slotId: 'model.sidebar_top', priority: 10 }],
  },
  fileSummary: { files: [], added: [], removed: [], changed: [] },
  manifestDiffSummary: { kind: 'first-version', fields: ['name'] },
  reviewRepoUrl: 'https://forgejo.example/repo',
  pushCommitUrl: null as string | null,
  submittedBy: { id: 7, username: 'dev-user', image: null },
};

const APPROVED = {
  ...PENDING,
  id: 'req-2',
  slug: 'approved-block',
  reviewedAt: new Date('2026-01-02T00:00:00Z'),
  approvalNotes: 'looks good',
  reviewedBy: { id: 99, username: 'mod-user', image: null },
};

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
  errorMode: false,
  reviewStatus: undefined as unknown,
  pending: false,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));

vi.mock('~/components/Apps/ReviewBlockPreviewHost', () => ({
  ReviewBlockPreviewHost: () => <div data-testid="review-host-stub" />,
}));

const showError = vi.fn();
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: (...a: unknown[]) => showError(...a),
}));

vi.mock('~/utils/trpc', () => {
  const mutation =
    (name: string) =>
    (opts?: { onSuccess?: () => void; onError?: (e: { message: string }) => void }) => ({
      mutate: (vars: unknown) => {
        mocks.mutate(name, vars);
        if (mocks.errorMode) opts?.onError?.({ message: 'boom' });
        else void opts?.onSuccess?.();
      },
      mutateAsync: vi.fn(),
      isPending: mocks.pending,
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
        getReviewStatus: {
          useQuery: () => ({ data: mocks.reviewStatus, isLoading: false, error: null }),
        },
        previewRequest: { useMutation: mutation('preview') },
        teardownPreview: { useMutation: mutation('teardown') },
        getPublishRequestScreenshots: {
          useQuery: () => ({ data: { items: [] }, isLoading: false, error: null }),
        },
        getPublishRequestDiff: {
          useQuery: () => ({ data: undefined, isLoading: false, error: null }),
        },
        getMarketplaceMeta: {
          useQuery: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
        },
        setMarketplaceMeta: { useMutation: mutation('setMeta') },
      },
    },
  };
});

const { ReviewDetailView } = await import('./ReviewDetailView');
const router = useRouter();

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.mutate.mockClear();
  mocks.errorMode = false;
  mocks.reviewStatus = undefined;
  mocks.pending = false;
  showError.mockClear();
  (router.events.on as any).mockClear();
});

describe('ReviewDetailView — sticky action bar', () => {
  test('a pending submission renders the review body AND the pinned approve/reject action bar', async () => {
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    // Body content is present (shared review body).
    await expect.element(page.getByText('View full source')).toBeInTheDocument();
    // The pinned action bar (labelled group) with both terminal actions.
    const bar = page.getByRole('group', { name: 'Review actions' });
    await expect.element(bar).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Reject…' })).toBeInTheDocument();
  });

  test('a read-only approved submission renders NO action bar', async () => {
    renderWithProviders(
      <ReviewDetailView selection={{ request: APPROVED, mode: 'approved' }} onClose={vi.fn()} />
    );
    await expect.element(page.getByText('Approved by @mod-user')).toBeInTheDocument();
    expect(page.getByRole('group', { name: 'Review actions' }).elements()).toHaveLength(0);
    expect(page.getByRole('button', { name: 'Approve + build' }).elements()).toHaveLength(0);
  });
});

describe('ReviewDetailView — focus management', () => {
  test('focus moves to the labelled main review region on mount (not left on <body>)', async () => {
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    const region = page.getByRole('region', { name: /Review of my-block v1\.2\.0/ });
    await expect.element(region).toBeInTheDocument();
    const regionEl = region.element();
    await vi.waitFor(() => expect(document.activeElement).toBe(regionEl));
  });
});

describe('ReviewDetailView — approve fires the mutation and redirects', () => {
  test('clicking Approve + build fires blocks.approveRequest and invokes onClose (redirect to queue)', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={onClose} />
    );
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(mocks.mutate).toHaveBeenCalledWith(
      'approve',
      expect.objectContaining({ publishRequestId: 'req-1' })
    );
    expect(onClose).toHaveBeenCalled();
  });

  test('reject goes through the reason gate then fires blocks.rejectRequest with the trimmed reason', async () => {
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    await page.getByRole('button', { name: 'Reject…' }).click();
    const confirm = page.getByTestId('apps-review-reject-confirm');
    await expect.element(confirm).toBeDisabled();
    await page.getByTestId('apps-review-reject-reason').fill('needs changes');
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    expect(mocks.mutate).toHaveBeenCalledWith('reject', {
      publishRequestId: 'req-1',
      rejectionReason: 'needs changes',
    });
  });
});

describe('ReviewDetailView — aria-live status region', () => {
  test('announces "approved" after a successful approve', async () => {
    // onClose is a spy (no real navigation) so the component stays mounted and the
    // live region can be asserted post-success.
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    const live = page.getByTestId('apps-review-status-live');
    // Wait for the async mount before touching the element (browser mode commits
    // asynchronously); idle → empty.
    await expect.element(live).toBeInTheDocument();
    expect(live.element().textContent).toBe('');
    await page.getByRole('button', { name: 'Approve + build' }).click();
    await vi.waitFor(() =>
      expect(live.element().textContent).toContain('Submission approved')
    );
  });

  test('announces "submitting" while a mutation is in flight', async () => {
    mocks.pending = true;
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    const live = page.getByTestId('apps-review-status-live');
    await vi.waitFor(() =>
      expect(live.element().textContent).toContain('Submitting the review decision')
    );
  });
});

describe('ReviewDetailView — route-leave guard', () => {
  test('registers a routeChangeStart guard while an approve/reject mutation is in flight', async () => {
    mocks.pending = true;
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    // The action bar reports "submitting" → the view arms the navigation guard.
    await vi.waitFor(() => {
      const regs = (router.events.on as any).mock.calls.filter(
        (c: unknown[]) => c[0] === 'routeChangeStart'
      );
      expect(regs.length).toBeGreaterThanOrEqual(1);
    });
  });

  test('does NOT register a routeChangeStart guard when idle', async () => {
    renderWithProviders(
      <ReviewDetailView selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeInTheDocument();
    const regs = (router.events.on as any).mock.calls.filter(
      (c: unknown[]) => c[0] === 'routeChangeStart'
    );
    expect(regs).toHaveLength(0);
  });
});
