import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
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

// A SECOND pending request (distinct `id`) used to prove the transient
// approve/reject state does not leak when the mod switches from one app to
// another in the same long-lived modal.
const ONSITE_PENDING_B = {
  ...ONSITE_PENDING,
  id: 'onsite-req-3',
  slug: 'other-onsite-block',
};

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
  errorMode: false,
  // Drives the getReviewStatus mock so a test can flip the Review-preview panel
  // into the live state (default undefined = no preview → "Start preview").
  reviewStatus: undefined as unknown,
  // When true, the approve/reject mutation mocks report `isPending: true` so the
  // component's `busy` state (and the ref-published close-guard) can be exercised.
  pending: false,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));

// Stub the review host bridge so the live-preview branch can render (and the
// full-page link asserted) WITHOUT mounting the real PageBlockHost graph. The
// bridge's own behaviour is covered by PageBlockHostReviewMode.browser.test.tsx.
vi.mock('~/components/Apps/ReviewBlockPreviewHost', () => ({
  ReviewBlockPreviewHost: () => <div data-testid="review-host-stub" />,
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
        // Sub-panel queries the modal mounts (Review-preview / Screenshots / Code
        // diff) — kept network-free with empty/no-op state.
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
  mocks.reviewStatus = undefined;
  mocks.pending = false;
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
    await expect.element(page.getByText('Permissions (1)')).toBeInTheDocument();
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

describe('OnsiteReviewModal — per-scope justifications shown to the mod', () => {
  test('renders each declared permission with its dev-supplied justification, and a "No justification provided" fallback when absent', async () => {
    const withJustifications = {
      ...ONSITE_PENDING,
      id: 'onsite-req-justify',
      slug: 'justify-block',
      manifest: {
        ...ONSITE_PENDING.manifest,
        scopes: ['models:read:self', 'user:read:self'],
        // Only the first scope carries a justification — the second must fall back.
        scopeJustifications: {
          'models:read:self': 'We render the page model in a side-by-side comparison widget.',
        },
      },
    };
    renderWithProviders(
      <OnsiteReviewModal
        selection={{ request: withJustifications, mode: 'pending' }}
        onClose={vi.fn()}
      />
    );
    // Header uses the renamed "Permissions" copy with the count.
    await expect.element(page.getByText('Permissions (2)')).toBeInTheDocument();
    // The supplied justification is surfaced verbatim under its badge, prefixed
    // with the "Why:" label. Exact match on the full paragraph disambiguates from
    // the raw manifest-JSON panel (which contains the string but not "Why:").
    await expect
      .element(
        page.getByText('Why: We render the page model in a side-by-side comparison widget.', {
          exact: true,
        })
      )
      .toBeInTheDocument();
    // The scope with no justification shows the muted fallback.
    await expect.element(page.getByText('No justification provided')).toBeInTheDocument();
  });
});

describe('OnsiteReviewModal — live preview links to the full-page route (not the raw host)', () => {
  test('a live preview renders the "Open full-page preview" link (internal same-origin route, new tab) and NOT the old raw-host button', async () => {
    // Flip the shared getReviewStatus poll into the live state. previewUrl carries
    // the raw `?mr=` host URL the OLD "Open review host" button used to link — the
    // new button must ignore it and link to the internal /apps/review/preview route.
    mocks.reviewStatus = {
      state: 'preview-live',
      detail: { host: 'my-onsite-block.civit.ai', url: 'https://my-onsite-block.civit.ai/my-onsite-block' },
      previewUrl: 'https://my-onsite-block.civit.ai/my-onsite-block?mr=raw-entry-token',
    };
    renderWithProviders(
      <OnsiteReviewModal selection={{ request: ONSITE_PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );

    const link = page.getByRole('link', { name: /Open full-page preview/ });
    await expect.element(link).toBeInTheDocument();
    // Same-origin internal route, keyed by publishRequestId — NOT the raw `?mr=` URL.
    const el = link.element() as HTMLAnchorElement;
    expect(el.getAttribute('href')).toBe('/apps/review/preview/onsite-req-1');
    expect(el.getAttribute('target')).toBe('_blank');
    expect(el.getAttribute('href')).not.toContain('?mr=');
    expect(el.getAttribute('href')).not.toContain('civit.ai');

    // The old raw-host button is GONE, and no anchor in the panel links to the
    // broken raw `?mr=` host URL.
    expect(page.getByText('Open review host').elements()).toHaveLength(0);
    const rawHostLinks = page
      .getByRole('link')
      .elements()
      .filter((a) => (a as HTMLAnchorElement).getAttribute('href')?.includes('?mr='));
    expect(rawHostLinks).toHaveLength(0);
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

describe('OnsiteReviewModal — transient approve/reject state resets per request', () => {
  test('switching from a request in reject-mode to a different request opens in the default view mode with an empty reason', async () => {
    // Render request A and put it into reject mode with a typed reason.
    const { rerender } = await renderWithProviders(
      <OnsiteReviewModal
        selection={{ request: ONSITE_PENDING, mode: 'pending' }}
        onClose={vi.fn()}
      />
    );
    await page.getByRole('button', { name: 'Reject…' }).click();
    const reasonA = page.getByTestId('apps-review-reject-reason');
    await expect.element(reasonA).toBeInTheDocument();
    await reasonA.fill('this needs changes before approval');
    await expect.element(reasonA).toHaveValue('this needs changes before approval');

    // Switch the SAME long-lived modal to a DIFFERENT pending request (new id).
    await rerender(
      <OnsiteReviewModal
        selection={{ request: ONSITE_PENDING_B, mode: 'pending' }}
        onClose={vi.fn()}
      />
    );

    // B must open in the DEFAULT view mode: the approve/notes UI is shown and
    // the reject textarea is gone (actionMode reset to 'view' via the keyed
    // remount — not carried over from A).
    await expect
      .element(page.getByRole('textbox', { name: 'Approval notes (optional)' }))
      .toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Approve + build' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Reject…' })).toBeInTheDocument();
    // The reject reason field from A must NOT be present (and thus carries no text).
    expect(page.getByTestId('apps-review-reject-reason').elements()).toHaveLength(0);

    // And re-entering reject mode on B starts from an EMPTY reason (A's text did
    // not leak into B's state).
    await page.getByRole('button', { name: 'Reject…' }).click();
    await expect.element(page.getByTestId('apps-review-reject-reason')).toHaveValue('');
  });

  test('the real close-then-reopen path (A → selection=null → B) also opens B fresh', async () => {
    // Production never swaps A→B directly: the parent sets `selection=null`
    // (closing the modal) and later sets it to B. This pins the
    // `{selection && <Body/>}` unmount-gate — B mounts fresh because the body
    // was unmounted at null — independently of the per-id `key` remount above.
    const { rerender } = await renderWithProviders(
      <OnsiteReviewModal
        selection={{ request: ONSITE_PENDING, mode: 'pending' }}
        onClose={vi.fn()}
      />
    );
    await page.getByRole('button', { name: 'Reject…' }).click();
    const reasonA = page.getByTestId('apps-review-reject-reason');
    await reasonA.fill('leaky reason that must not survive a close');
    await expect.element(reasonA).toHaveValue('leaky reason that must not survive a close');

    // Close the modal (selection → null): the body unmounts.
    await rerender(<OnsiteReviewModal selection={null} onClose={vi.fn()} />);
    expect(page.getByTestId('apps-review-reject-reason').elements()).toHaveLength(0);

    // Reopen with a different request B: the body remounts fresh.
    await rerender(
      <OnsiteReviewModal
        selection={{ request: ONSITE_PENDING_B, mode: 'pending' }}
        onClose={vi.fn()}
      />
    );

    // B opens in the default view mode, no leaked reject state.
    await expect
      .element(page.getByRole('textbox', { name: 'Approval notes (optional)' }))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-review-reject-reason').elements()).toHaveLength(0);
    await page.getByRole('button', { name: 'Reject…' }).click();
    await expect.element(page.getByTestId('apps-review-reject-reason')).toHaveValue('');
  });
});

describe('OnsiteReviewModal — busy close-guard while a mutation is in flight', () => {
  test('does not call onClose via Escape or the close button while a mutation is pending', async () => {
    // Both mutation mocks report isPending:true → the modal is `busy`, so the
    // body publishes busy=true to the shell via the ref. The shell's onClose
    // (Escape / overlay / the X) must then refuse to invoke the parent onClose.
    mocks.pending = true;
    const onClose = vi.fn();
    renderWithProviders(
      <OnsiteReviewModal selection={{ request: ONSITE_PENDING, mode: 'pending' }} onClose={onClose} />
    );
    // Modal is open (body rendered).
    await expect.element(page.getByText('View code in Forgejo')).toBeInTheDocument();

    // Close vector 1 — the modal's close (X) button (Mantine static class).
    const closeBtn = document.querySelector<HTMLButtonElement>('.mantine-Modal-close');
    expect(closeBtn).not.toBeNull();
    await userEvent.click(closeBtn!);

    // Close vector 2 — Escape (Mantine `closeOnEscape`).
    await userEvent.keyboard('{Escape}');

    // The busy guard swallowed both — the parent onClose was never called and the
    // modal is still mounted.
    expect(onClose).not.toHaveBeenCalled();
    await expect.element(page.getByText('View code in Forgejo')).toBeInTheDocument();
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
