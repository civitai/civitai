import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * `ReviewActionBar` — the approve/reject control surface extracted from
 * `OnsiteReviewModalBody` so the modal (inline footer) and the review PAGE (sticky
 * bottom bar) render the SAME controls + mutations from one source.
 *
 * This suite is the proof the extraction is behaviour-preserving (it ports the
 * modal's approve-fires / reject-gate / error / read-only assertions onto the bar
 * directly) PLUS the NEW page-facing surface: the `onStatusChange` mutation-status
 * callback (submitting / approved / rejected / error) the page uses to drive its
 * aria-live region and route-leave guard, and the `busyRef` the modal still writes.
 */

const PENDING = {
  id: 'req-1',
  appBlockId: null as string | null,
  slug: 'my-block',
  version: '1.2.0',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
  bundleSizeBytes: '2048',
  bundleSha256: 'abc',
  manifest: { name: 'My Block', scopes: ['user:read'], targets: [] },
  fileSummary: { files: [], added: [], removed: [], changed: [] },
  manifestDiffSummary: { kind: 'first-version', fields: ['name'] },
  reviewRepoUrl: 'https://forgejo.example/repo',
  pushCommitUrl: null as string | null,
  submittedBy: { id: 7, username: 'dev-user', image: null },
};

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
  errorMode: false,
  pending: false,
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
    },
  };
  return {
    trpc: {
      useUtils: () => utils,
      blocks: {
        approveRequest: { useMutation: mutation('approve') },
        rejectRequest: { useMutation: mutation('reject') },
      },
    },
  };
});

const { ReviewActionBar } = await import('./ReviewActionBar');

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.mutate.mockClear();
  mocks.errorMode = false;
  mocks.pending = false;
  showError.mockClear();
});

describe('ReviewActionBar — approve', () => {
  test('renders both action entry points on a pending request and Approve fires the mutation with the id + trimmed notes', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ReviewActionBar selection={{ request: PENDING, mode: 'pending' }} onClose={onClose} />
    );
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Reject…' })).toBeInTheDocument();

    // Optional approval notes are trimmed and threaded into the payload (the
    // previously-uncovered path called out in the plan's test matrix).
    await page.getByRole('textbox', { name: 'Approval notes (optional)' }).fill('  ship it  ');
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(mocks.mutate).toHaveBeenCalledWith('approve', {
      publishRequestId: 'req-1',
      approvalNotes: 'ship it',
    });
    expect(onClose).toHaveBeenCalled();
  });

  test('an approve error surfaces via showErrorNotification and does NOT close', async () => {
    mocks.errorMode = true;
    const onClose = vi.fn();
    renderWithProviders(
      <ReviewActionBar selection={{ request: PENDING, mode: 'pending' }} onClose={onClose} />
    );
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(showError).toHaveBeenCalledWith(expect.objectContaining({ title: 'Approve failed' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ReviewActionBar — reject reason gate', () => {
  test('the reject confirm is gated under the 3-char floor, then fires with the trimmed reason', async () => {
    renderWithProviders(
      <ReviewActionBar selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    // No textarea until Reject… is clicked.
    expect(page.getByTestId('apps-review-reject-reason').elements()).toHaveLength(0);
    await page.getByRole('button', { name: 'Reject…' }).click();

    const confirm = page.getByTestId('apps-review-reject-confirm');
    await expect.element(confirm).toBeDisabled();
    await page.getByTestId('apps-review-reject-reason').fill('no');
    await expect.element(confirm).toBeDisabled();
    // Whitespace padding doesn't satisfy the gate (trimmed length counts).
    await page.getByTestId('apps-review-reject-reason').fill('  a  ');
    await expect.element(confirm).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();

    await page.getByTestId('apps-review-reject-reason').fill('needs changes');
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    expect(mocks.mutate).toHaveBeenCalledWith('reject', {
      publishRequestId: 'req-1',
      rejectionReason: 'needs changes',
    });
  });
});

describe('ReviewActionBar — read-only history renders nothing', () => {
  test('an approved selection renders no approve/reject controls (self-suppresses)', async () => {
    renderWithProviders(
      <ReviewActionBar selection={{ request: PENDING, mode: 'approved' }} onClose={vi.fn()} />
    );
    expect(page.getByRole('button', { name: 'Approve + build' }).elements()).toHaveLength(0);
    expect(page.getByRole('button', { name: 'Reject…' }).elements()).toHaveLength(0);
  });
});

describe('ReviewActionBar — modal busyRef + page onStatusChange observers', () => {
  test('writes busy=true to busyRef while a mutation is pending (the modal close-guard)', async () => {
    mocks.pending = true;
    const busyRef = { current: false };
    renderWithProviders(
      <ReviewActionBar
        selection={{ request: PENDING, mode: 'pending' }}
        onClose={vi.fn()}
        busyRef={busyRef}
      />
    );
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeInTheDocument();
    expect(busyRef.current).toBe(true);
  });

  test('reports "submitting" via onStatusChange while a mutation is pending', async () => {
    mocks.pending = true;
    const onStatusChange = vi.fn();
    renderWithProviders(
      <ReviewActionBar
        selection={{ request: PENDING, mode: 'pending' }}
        onClose={vi.fn()}
        onStatusChange={onStatusChange}
      />
    );
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeInTheDocument();
    expect(onStatusChange).toHaveBeenCalledWith('submitting');
  });

  test('reports "approved" on a successful approve and "error" on a failed one', async () => {
    const onStatusChange = vi.fn();
    const { rerender } = await renderWithProviders(
      <ReviewActionBar
        selection={{ request: PENDING, mode: 'pending' }}
        onClose={vi.fn()}
        onStatusChange={onStatusChange}
      />
    );
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(onStatusChange).toHaveBeenCalledWith('approved');

    // A failed approve reports 'error' (fresh render so the mock flips to errorMode).
    onStatusChange.mockClear();
    mocks.errorMode = true;
    await rerender(
      <ReviewActionBar
        selection={{ request: PENDING, mode: 'pending' }}
        onClose={vi.fn()}
        onStatusChange={onStatusChange}
      />
    );
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(onStatusChange).toHaveBeenCalledWith('error');
  });

  test('the sticky variant wraps the controls in a labelled action group', async () => {
    renderWithProviders(
      <ReviewActionBar selection={{ request: PENDING, mode: 'pending' }} onClose={vi.fn()} sticky />
    );
    // The pinned bar is a labelled group so screen readers announce it.
    await expect.element(page.getByRole('group', { name: 'Review actions' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeInTheDocument();
  });
});
