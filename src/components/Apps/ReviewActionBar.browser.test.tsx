import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcMod from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

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
  submittedBy: { id: 7, username: 'dev-user', deletedAt: null, image: null },
};

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
  errorMode: false,
  pending: false,
  assets: { data: undefined as unknown, isError: false },
  assetsQuery: vi.fn(),
}));

const showError = vi.fn();
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: (...a: unknown[]) => showError(...a),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
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
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'blocks.approveRequest': { useMutation: mutation('approve') },
        'blocks.rejectRequest': { useMutation: mutation('reject') },
        'appListings.getAssets': {
          useQuery: (input: unknown, opts: unknown) => {
            mocks.assetsQuery(input, opts);
            return { data: mocks.assets.data, isError: mocks.assets.isError };
          },
        },
      },
      { useUtils: () => utils }
    ),
  };
});

const { ReviewActionBar } = await import('./ReviewActionBar');

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.mutate.mockClear();
  mocks.errorMode = false;
  mocks.pending = false;
  mocks.assets = { data: undefined, isError: false };
  mocks.assetsQuery.mockClear();
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

  test('fires onActioned after a successful approve, before onClose (paging-reset symmetry)', async () => {
    const order: string[] = [];
    const onActioned = vi.fn(() => {
      order.push('actioned');
    });
    const onClose = vi.fn(() => {
      order.push('close');
    });
    renderWithProviders(
      <ReviewActionBar
        selection={{ request: PENDING, mode: 'pending' }}
        onClose={onClose}
        onActioned={onActioned}
      />
    );
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(onActioned).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    // onActioned runs BEFORE the modal close so the queue is reset while still open.
    expect(order).toEqual(['actioned', 'close']);
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

  test('a successful reject also fires onActioned', async () => {
    const onActioned = vi.fn();
    renderWithProviders(
      <ReviewActionBar
        selection={{ request: PENDING, mode: 'pending' }}
        onClose={vi.fn()}
        onActioned={onActioned}
      />
    );
    await page.getByRole('button', { name: 'Reject…' }).click();
    await page.getByTestId('apps-review-reject-reason').fill('needs changes');
    await page.getByTestId('apps-review-reject-confirm').click();
    expect(onActioned).toHaveBeenCalledTimes(1);
  });

  test('a FAILED approve does NOT fire onActioned (no stale paging reset on error)', async () => {
    mocks.errorMode = true;
    const onActioned = vi.fn();
    renderWithProviders(
      <ReviewActionBar
        selection={{ request: PENDING, mode: 'pending' }}
        onClose={vi.fn()}
        onActioned={onActioned}
      />
    );
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(onActioned).not.toHaveBeenCalled();
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

describe('ReviewActionBar — approving will raise the listing’s rating', () => {
  // NsfwLevel bits: PG 1, PG-13 2, R 4.
  const assetsWithShot2At = (level: number | null, over: Record<string, unknown> = {}) => ({
    iconId: 41,
    coverId: 53,
    iconNsfwLevel: 1,
    coverNsfwLevel: 2,
    screenshots: [
      { imageId: 61, nsfwLevel: 1 },
      { imageId: 67, nsfwLevel: level },
    ],
    hasPendingScan: false,
    hasBlockedAsset: false,
    ...over,
  });
  const reRated = (over: Record<string, unknown> = {}) => ({
    ...PENDING,
    appListingId: 'apl_joined',
    approveRating: { listingId: 'apl_draft', declared: 'g' as string | null },
    ...over,
  });
  const bar = (request: ReturnType<typeof reRated>) =>
    renderWithProviders(
      <ReviewActionBar selection={{ request, mode: 'pending' }} onClose={vi.fn()} />
    );
  const alertText = async () => {
    const alert = page.getByTestId('apps-onsite-rating-mismatch');
    await expect.element(alert).toBeInTheDocument();
    return alert.element().textContent;
  };
  const approveVisibleWithoutAlert = async () => {
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeInTheDocument();
    expect(page.getByTestId('apps-onsite-rating-mismatch').elements()).toHaveLength(0);
  };

  test('declared G + an R screenshot: says approving raises the listing to R, hides it, and names the screenshot', async () => {
    mocks.assets.data = assetsWithShot2At(4);
    bar(reRated());
    expect(await alertText()).toBe(
      'Store imagery is rated higher (R) than the app’s declared rating (G). Approving raises the store listing to R, which hides it from the civitai.com marketplace (it stays visible on civitai.red). If the app itself is not that mature, reject and ask the author to replace the image.Rated highest: Screenshot 2 (R).'
    );
    // Re-read on every open: the author can swap an image between two opens.
    expect(mocks.assetsQuery).toHaveBeenCalledWith(
      { listingId: 'apl_draft' },
      { staleTime: 0, refetchOnMount: 'always', retry: false }
    );
    // Still approvable — it is a warning, not a gate.
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeEnabled();
  });

  test('a raise to PG-13 is warned about without the hidden-from-the-marketplace clause', async () => {
    mocks.assets.data = assetsWithShot2At(1);
    bar(reRated());
    expect(await alertText()).toBe(
      'Store imagery is rated higher (PG-13) than the app’s declared rating (G). Approving raises the store listing to PG-13. If the app itself is not that mature, reject and ask the author to replace the image.Rated highest: Cover (PG-13).'
    );
  });

  test.each([{ hasPendingScan: true }, { hasBlockedAsset: true }])(
    'media not scanned clean (%o): the warning adds that this approve does not publish the listing yet',
    async (scan) => {
      mocks.assets.data = assetsWithShot2At(4, scan);
      bar(reRated());
      expect(await alertText()).toBe(
        'Store imagery is rated higher (R) than the app’s declared rating (G). Approving raises the store listing to R, which hides it from the civitai.com marketplace (it stays visible on civitai.red). If the app itself is not that mature, reject and ask the author to replace the image. The listing only goes live once all of its media has scanned clean.Rated highest: Screenshot 2 (R).'
      );
    }
  );

  test('the comparison uses the rating the SERVER says the approve starts from', async () => {
    mocks.assets.data = assetsWithShot2At(4);
    bar(reRated({ approveRating: { listingId: 'apl_draft', declared: 'r' } }));
    await approveVisibleWithoutAlert();
    expect(mocks.assetsQuery).toHaveBeenCalled();
  });

  test('a null starting rating is treated as SFW and shown as a dash', async () => {
    mocks.assets.data = assetsWithShot2At(4);
    bar(reRated({ approveRating: { listingId: 'apl_draft', declared: null } }));
    await expect
      .element(page.getByTestId('apps-onsite-rating-mismatch'))
      .toHaveTextContent(
        'than the app’s declared rating (—). Approving raises the store listing to R'
      );
  });

  test('an approve that does not re-rate the listing asks for nothing and warns of nothing', async () => {
    mocks.assets.data = assetsWithShot2At(4);
    bar(reRated({ approveRating: null }));
    await approveVisibleWithoutAlert();
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeEnabled();
    expect(mocks.assetsQuery).not.toHaveBeenCalled();
  });

  test('the levels are read for the listing the SERVER says is re-rated, joined or not', async () => {
    mocks.assets.data = assetsWithShot2At(4);
    bar(reRated({ appListingId: null }));
    await expect.element(page.getByTestId('apps-onsite-rating-mismatch')).toBeInTheDocument();
    expect(mocks.assetsQuery).toHaveBeenCalledWith(
      { listingId: 'apl_draft' },
      { staleTime: 0, refetchOnMount: 'always', retry: false }
    );
  });

  test('🔴 while the levels are loading it says it is checking, and approve waits for them', async () => {
    bar(reRated());
    await expect.element(page.getByTestId('apps-onsite-rating-checking')).toBeInTheDocument();
    await approveVisibleWithoutAlert();
    // Approving now would send a split decision nobody has seen.
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeDisabled();
  });

  test('a failed asset read is said out loud rather than read as "nothing to warn about"', async () => {
    mocks.assets = { data: undefined, isError: true };
    bar(reRated());
    await expect.element(page.getByTestId('apps-onsite-rating-unchecked')).toBeInTheDocument();
    expect(page.getByTestId('apps-onsite-rating-mismatch').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-onsite-rating-checking').elements()).toHaveLength(0);
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeDisabled();
  });

  test('🔴 a split the app cannot read: no choice, a note, and the on-site approve sends no decision', async () => {
    // `null` = the write role cannot read the record. The operator's rule (2026-10-18): approve
    // proceeds with NO split decision, exactly as before the split existed.
    mocks.assets.data = { ...assetsWithShot2At(4), mediaSplitApproved: null };
    bar(reRated());
    // The WHOLE note, pinned literally: it states what this approve does, so a reword is a claim
    // change (the on-site approve floors the rating by all media; an earlier split is not applied).
    const note = page.getByTestId('apps-media-split-unreadable');
    await expect.element(note).toBeInTheDocument();
    expect((note.element().textContent ?? '').replace(/\s+/g, ' ').trim()).toBe(
      'This environment cannot read whether this listing’s media is split between civitai.com and civitai.red. Approving approves the listing with its rating covering all of its media, as before media splits existed. Any split recorded earlier is kept on file but not applied while this environment cannot read it. Split choices are unavailable until the database grant for the media-split record is fixed.'
    );
    expect(page.getByTestId('apps-media-split').elements()).toHaveLength(0);
    const approve = page.getByRole('button', { name: 'Approve + build' });
    await expect.element(approve).toBeEnabled();
    await approve.click();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const [name, vars] = mocks.mutate.mock.calls[0];
    expect(name).toBe('approve');
    expect(vars).toEqual({ publishRequestId: 'req-1', approvalNotes: undefined });
    expect(vars).not.toHaveProperty('mediaSplit');
  });

  test('🔴 an already-split listing keeps its split by default on the on-site approve', async () => {
    mocks.assets.data = { ...assetsWithShot2At(4), mediaSplitApproved: true };
    bar(reRated());
    await expect.element(page.getByTestId('apps-media-split-current')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeEnabled();
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(mocks.mutate).toHaveBeenCalledWith('approve', {
      publishRequestId: 'req-1',
      approvalNotes: undefined,
      mediaSplit: 'split',
    });
  });

  test('🔴 the media split: the warning follows the choice and approve sends it', async () => {
    mocks.assets.data = assetsWithShot2At(4);
    bar(reRated());
    await expect.element(page.getByTestId('apps-onsite-rating-mismatch')).toBeInTheDocument();
    await page.getByTestId('apps-media-split-split').click();
    // Split: only the civitai.com-eligible images floor the rating — the PG-13 cover now leads.
    await expect
      .element(page.getByTestId('apps-onsite-rating-mismatch'))
      .toHaveTextContent('Approving raises the store listing to PG-13.');
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(mocks.mutate).toHaveBeenCalledWith('approve', {
      publishRequestId: 'req-1',
      approvalNotes: undefined,
      mediaSplit: 'split',
    });
  });

  test('without a choice approve sends rate-mature', async () => {
    mocks.assets.data = assetsWithShot2At(4);
    bar(reRated());
    await expect.element(page.getByTestId('apps-media-split')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Approve + build' }).click();
    expect(mocks.mutate).toHaveBeenCalledWith('approve', {
      publishRequestId: 'req-1',
      approvalNotes: undefined,
      mediaSplit: 'rate-mature',
    });
  });
});
