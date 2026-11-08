import { cleanNotifications, cleanNotificationsQueue, Notifications } from '@mantine/notifications';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as UserAvatarMod from '~/components/UserAvatar/UserAvatar';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The review PAGE's decision flow, rendered through the real `ReviewDetailView`:
 *  - "Approve & next" records a DELAYED approval — nothing is sent at click time, the page
 *    moves on at once (`onClose`), and the undo toast counts down;
 *  - Undo sends nothing and returns to the request; letting it run sends EXACTLY once;
 *  - a double click cannot approve twice;
 *  - reject is Reject… → a reason chip (PREFILLS the editable text) → Reject;
 *  - the reason counter reads "3+ characters", ticked when met;
 *  - the header names what is under review;
 *  - the Overview renders every AI-review and preview state;
 *  - "next" is the oldest pending request, and the end of the queue is "All caught up".
 *
 * The 10-second CLOCK is not driven here: the engine's timing (fires at the deadline and not
 * before, undo inside the window, navigation keeps the timer, leaving commits) is pinned with
 * a hand-driven clock in `__tests__/pendingApprovalQueue.test.ts`. This file proves the page is
 * WIRED to that engine — `commitNow` stands in for the deadline.
 */

const m = vi.hoisted(() => ({
  flags: { appBlocks: true, appReviewPage: true } as Record<string, boolean>,
  mutate: vi.fn(),
  clientApprove: vi.fn(),
  agentReview: undefined as unknown,
  reviewStatus: undefined as unknown,
  pendingItems: undefined as unknown,
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => m.flags,
  useOptionalFeatureFlags: () => m.flags,
}));
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarMod>()),
  UserAvatar: ({ user }: { user: { username?: string | null } }) => <span>{user.username}</span>,
}));
vi.mock('~/components/Apps/ReviewBlockPreviewHost', () => ({
  ReviewBlockPreviewHost: () => <div data-testid="review-host-stub" />,
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const mutation = (name: string) => (opts?: { onSuccess?: () => void }) => ({
    mutate: (vars: unknown) => {
      m.mutate(name, vars);
      void opts?.onSuccess?.();
    },
    mutateAsync: vi.fn(),
    isPending: false,
  });
  const inert = { invalidate: vi.fn(async () => undefined) };
  return {
    ...actual,
    trpc: makeTrpcProxy(
      {
        'blocks.approveRequest': { useMutation: mutation('approve') },
        'blocks.rejectRequest': { useMutation: mutation('reject') },
        'blocks.getAgentReview': {
          useQuery: () => ({ data: m.agentReview, isLoading: false, error: null }),
        },
        'blocks.getReviewStatus': {
          useQuery: () => ({ data: m.reviewStatus, isLoading: false, error: null }),
        },
        'blocks.listPendingRequests': {
          useQuery: () => ({ data: m.pendingItems, isLoading: false, error: null }),
        },
        'blocks.getPublishRequestScreenshots': {
          useQuery: () => ({ data: { items: [] }, isLoading: false, error: null }),
        },
      },
      {
        useUtils: () => ({
          client: { blocks: { approveRequest: { mutate: m.clientApprove } } },
          blocks: {
            listPendingRequests: inert,
            listApprovedRequests: inert,
            listRejectedRequests: inert,
            countReviewQueue: inert,
            getReviewStatus: inert,
            listActivePreviews: inert,
            getAgentReview: inert,
          },
        }),
      }
    ),
  };
});

const { ReviewDetailView, AllCaughtUp } = await import('./ReviewDetailView');
const { reviewApprovalQueue } = await import('./pendingApprovalQueue');
const { useNextPendingReview } = await import('./useNextPendingReview');
// eslint-disable-next-line react-hooks/rules-of-hooks -- the scaffold's mock router is a plain singleton
const router = useRouter();

let seq = 0;
/** A fresh request id per test: the approval queue is an app-lifetime singleton. */
function pendingRequest(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `pubreq_flow_${seq}`,
    appBlockId: null,
    slug: 'gen-matrix',
    version: '0.2.0',
    submittedAt: new Date('2026-01-01T09:00:00Z'),
    bundleSizeBytes: '421888',
    bundleSha256: 'a'.repeat(64),
    manifest: {
      name: 'Gen Matrix',
      scopes: ['ai:write:budgeted', 'models:read:self'],
      scopeJustifications: { 'ai:write:budgeted': 'Runs the generation the user asked for.' },
    },
    fileSummary: { files: [], added: [], removed: [], changed: [] },
    manifestDiffSummary: { kind: 'first-version', fields: ['name'] },
    reviewRepoUrl: 'https://forgejo.example/repo',
    pushCommitUrl: null,
    submittedBy: { id: 7, username: 'dev-user', deletedAt: null, image: null },
    ...over,
  };
}

function renderPage(request: Record<string, unknown>, onClose = vi.fn()) {
  renderWithProviders(
    <>
      <Notifications />
      <ReviewDetailView
        selection={{ request: request as never, mode: 'pending' }}
        onClose={onClose}
      />
    </>
  );
  return onClose;
}

// The queue is an app-lifetime singleton and Mantine's notification store is global: a
// pending approval left by one test would fire its real 10 s timer into the next one, and its
// countdown toast would be found twice. Cancel whatever is still pending, and clear toasts.
afterEach(() => {
  for (const e of reviewApprovalQueue.getSnapshot()) {
    if (e.status === 'pending') reviewApprovalQueue.undo(e.id);
  }
  cleanNotifications();
  cleanNotificationsQueue();
});

beforeEach(async () => {
  cleanNotifications();
  cleanNotificationsQueue();
  m.flags = { appBlocks: true, appReviewPage: true };
  m.mutate.mockClear();
  m.clientApprove.mockReset();
  m.clientApprove.mockResolvedValue({ ok: true });
  m.agentReview = undefined;
  m.reviewStatus = undefined;
  m.pendingItems = undefined;
  router.query = {};
  router.pathname = '/apps/review/[publishRequestId]';
  vi.mocked(router.push).mockClear();
  await page.viewport(1124, 1305);
});

describe('"Approve & next" — the delayed commit, wired to the page', () => {
  test('🔴 click: NOTHING is sent, the page moves on at once, and the undo toast shows', async () => {
    const req = pendingRequest();
    const onClose = renderPage(req);
    await page.getByTestId('apps-review-approve-next').click();
    expect(onClose).toHaveBeenCalledTimes(1);
    // Neither the immediate mutation nor the client call ran.
    expect(m.mutate).not.toHaveBeenCalled();
    expect(m.clientApprove).not.toHaveBeenCalled();
    expect(reviewApprovalQueue.get(req.id)?.status).toBe('pending');
    await expect.element(page.getByTestId('apps-review-approve-countdown')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-review-approve-countdown'))
      .toHaveTextContent(/Approving gen-matrix v0\.2\.0 in \d+s/);
  });

  test('🔴 Undo inside the window sends NOTHING, ever, and goes back to the request', async () => {
    const req = pendingRequest();
    renderPage(req);
    await page.getByTestId('apps-review-approve-next').click();
    await page.getByTestId('apps-review-approve-undo').click();
    expect(reviewApprovalQueue.get(req.id)).toBeUndefined();
    // Even an explicit "leave now" afterwards has nothing to send.
    await reviewApprovalQueue.commitAll();
    expect(m.clientApprove).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith(`/apps/review/${req.id}`);
  });

  test('🔴 no undo: the deadline sends approveRequest EXACTLY once, with the request id', async () => {
    const req = pendingRequest();
    renderPage(req);
    await page.getByTestId('apps-review-approve-next').click();
    // `commitNow` stands in for the 10 s deadline (the clock is pinned in the node tier).
    await reviewApprovalQueue.commitNow(req.id);
    await reviewApprovalQueue.commitAll();
    expect(m.clientApprove).toHaveBeenCalledTimes(1);
    expect(m.clientApprove).toHaveBeenCalledWith({
      publishRequestId: req.id,
      approvalNotes: undefined,
    });
    expect(reviewApprovalQueue.get(req.id)?.status).toBe('committed');
  });

  test('🔴 a DOUBLE click records one approval and moves on once', async () => {
    const req = pendingRequest();
    const onClose = renderPage(req);
    const btn = page.getByTestId('apps-review-approve-next');
    await btn.dblClick();
    expect(onClose).toHaveBeenCalledTimes(1);
    await reviewApprovalQueue.commitNow(req.id);
    expect(m.clientApprove).toHaveBeenCalledTimes(1);
  });

  test('a FAILED commit raises a persistent error with Retry and re-opens the request', async () => {
    const req = pendingRequest();
    m.clientApprove.mockRejectedValueOnce(new Error('listing floor not met'));
    renderPage(req);
    await page.getByTestId('apps-review-approve-next').click();
    vi.mocked(router.push).mockClear();
    await reviewApprovalQueue.commitNow(req.id);
    await expect.element(page.getByTestId('apps-review-approve-failed')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-review-approve-failed'))
      .toHaveTextContent('listing floor not met');
    expect(router.push).toHaveBeenCalledWith(`/apps/review/${req.id}`);
    // Retry sends again — the failed id was released.
    await page.getByTestId('apps-review-approve-retry').click();
    await vi.waitFor(() => expect(m.clientApprove).toHaveBeenCalledTimes(2));
  });
});

describe('reject — Reject… → reason chip → Reject', () => {
  test('🔴 a chip PREFILLS the editable reason, and the third click sends it', async () => {
    const req = pendingRequest();
    renderPage(req);
    await page.getByRole('button', { name: 'Reject…' }).click();
    await page.getByTestId('apps-review-reject-chip-broken').click();
    const field = page.getByTestId('apps-review-reject-reason');
    await expect
      .element(field)
      .toHaveValue(
        'The app does not load or is broken in the review preview. Please fix it and resubmit.'
      );
    // Still editable.
    await field.fill('Broken on load — the preview shows a blank page.');
    await page.getByTestId('apps-review-reject-confirm').click();
    expect(m.mutate).toHaveBeenCalledWith('reject', {
      publishRequestId: req.id,
      rejectionReason: 'Broken on load — the preview shows a blank page.',
    });
  });

  test('three clicks, no typing: the chip text alone clears the floor', async () => {
    const req = pendingRequest();
    renderPage(req);
    await page.getByRole('button', { name: 'Reject…' }).click();
    await page.getByTestId('apps-review-reject-chip-duplicate').click();
    await page.getByTestId('apps-review-reject-confirm').click();
    expect(m.mutate).toHaveBeenCalledWith(
      'reject',
      expect.objectContaining({ publishRequestId: req.id })
    );
  });

  test('🔴 the counter reads "3+ characters", ticked once met — never "11/3"', async () => {
    renderPage(pendingRequest());
    await page.getByRole('button', { name: 'Reject…' }).click();
    await expect.element(page.getByText('3+ characters', { exact: true })).toBeInTheDocument();
    await page.getByTestId('apps-review-reject-reason').fill('needs changes to the listing');
    await expect.element(page.getByText('✓ 3+ characters', { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d+\/3 characters/);
  });
});

describe('the header names what is under review', () => {
  test('display name, slug, version, kind and first-version', async () => {
    renderPage(pendingRequest());
    await expect
      .element(page.getByTestId('apps-review-detail-name'))
      .toHaveTextContent('Gen Matrix');
    const header = page.getByTestId('apps-review-detail-header');
    await expect.element(header).toHaveTextContent('gen-matrix');
    await expect
      .element(page.getByTestId('apps-review-detail-version'))
      .toHaveTextContent('v0.2.0');
    await expect.element(page.getByTestId('apps-review-detail-kind')).toHaveTextContent('App');
    await expect.element(header).toHaveTextContent('first version');
    await expect.element(page.getByTestId('apps-review-submitted-age')).toBeInTheDocument();
  });
});

describe('the Overview renders every AI-review state', () => {
  const report = (status: string, findings: { severity: string }[] = [], scope = {}) => ({
    status,
    codeReview: { findings, priorFindingsReconciled: [] },
    securityAudit: { findings: [], manifestUnexpectedKeys: [], iframeSandboxGrants: [] },
    scopeVerdicts: { scopes: [], overBroad: [], underDeclared: [], ...scope },
  });

  test.each([
    ['no report', null, 'not-run', 'not run'],
    ['running', report('running'), 'running', 'running'],
    ['run failed', report('failed'), 'error', 'run failed'],
    ['high finding', report('complete', [{ severity: 'high' }]), 'fail', 'fail'],
    ['medium finding', report('complete', [{ severity: 'medium' }]), 'concerns', 'concerns'],
    [
      'over-broad scope',
      report('complete', [], { overBroad: ['ai:write:budgeted'] }),
      'concerns',
      'concerns',
    ],
    ['clean', report('complete', [{ severity: 'low' }]), 'pass', 'pass'],
    ['cost-capped clean', report('cost-capped'), 'pass', 'pass'],
  ] as const)('%s → %s', async (_name, data, verdict, label) => {
    m.flags = { appBlocks: true, appReviewPage: true, appBlocksAgenticReview: true };
    m.agentReview = data;
    renderPage(pendingRequest());
    const card = page.getByTestId('apps-review-overview-ai');
    await expect.element(card).toBeInTheDocument();
    expect(card.element().getAttribute('data-verdict')).toBe(verdict);
    await expect
      .element(page.getByTestId('apps-review-overview-ai-verdict'))
      .toHaveTextContent(label);
  });

  test('without the agentic flag the Overview shows no AI card at all (the gate is shared)', async () => {
    m.agentReview = report('complete', [{ severity: 'high' }]);
    renderPage(pendingRequest());
    await expect.element(page.getByTestId('apps-review-overview')).toBeInTheDocument();
    expect(page.getByTestId('apps-review-overview-ai').elements()).toHaveLength(0);
  });
});

describe('the Overview renders every preview state', () => {
  test.each([
    ['preview-queued', 'queued', 'apps-review-preview-queued'],
    ['preview-building', 'building', 'apps-review-preview-building'],
    ['preview-deploying', 'building', 'apps-review-preview-building'],
    ['preview-failed', 'failed', null],
    ['preview-expired', 'expired', 'apps-review-preview-expired'],
    ['preview-live', 'live', null],
  ] as const)('%s → %s', async (state, chip, marker) => {
    m.reviewStatus = {
      state,
      detail: {
        sha: 'f'.repeat(40),
        error: state === 'preview-failed' ? 'build failed' : undefined,
      },
      previewUrl: 'https://review.example/app?mr=t',
      updatedAt: new Date(Date.now() - 65_000),
    };
    renderPage(pendingRequest());
    await expect.element(page.getByTestId('apps-review-preview-state')).toHaveTextContent(chip);
    if (marker) await expect.element(page.getByTestId(marker)).toBeInTheDocument();
  });

  test('building says how long it usually takes, and how long it has been', async () => {
    m.reviewStatus = {
      state: 'preview-building',
      detail: {},
      updatedAt: new Date(Date.now() - 65_000),
    };
    renderPage(pendingRequest());
    await expect
      .element(page.getByTestId('apps-review-preview-building'))
      .toHaveTextContent(/Building — usually ~2 min · 1:0\d elapsed/);
  });

  test('no preview yet → "Start preview" is the action', async () => {
    renderPage(pendingRequest());
    await expect.element(page.getByRole('button', { name: 'Start preview' })).toBeInTheDocument();
  });
});

describe('what opens next', () => {
  function Harness({
    id,
    onReady,
  }: {
    id: string;
    onReady: (v: ReturnType<typeof useNextPendingReview>) => void;
  }) {
    const v = useNextPendingReview(id);
    useEffect(() => {
      onReady(v);
    });
    return v.caughtUp ? <AllCaughtUp /> : <div data-testid="next-harness" />;
  }

  test('🔴 the OLDEST pending request that is not this one and not awaiting an approval', async () => {
    const decided = pendingRequest();
    const inUndoWindow = pendingRequest();
    reviewApprovalQueue.enqueue({
      id: inUndoWindow.id,
      label: 'x',
      commit: async () => undefined,
    });
    m.pendingItems = {
      items: [
        { id: 'newest', submittedAt: new Date('2026-01-05T00:00:00Z') },
        { id: inUndoWindow.id, submittedAt: new Date('2025-12-01T00:00:00Z') },
        { id: decided.id, submittedAt: new Date('2025-11-01T00:00:00Z') },
        { id: 'oldest-other', submittedAt: new Date('2026-01-02T00:00:00Z') },
      ],
      nextCursor: null,
    };
    const api: { current: ReturnType<typeof useNextPendingReview> | null } = { current: null };
    renderWithProviders(<Harness id={decided.id} onReady={(v) => (api.current = v)} />);
    await vi.waitFor(() => expect(api.current).not.toBeNull());
    api.current?.openNext();
    expect(router.push).toHaveBeenCalledWith('/apps/review/oldest-other');
    reviewApprovalQueue.undo(inUndoWindow.id);
  });

  test('🔴 nothing left → "All caught up"', async () => {
    const decided = pendingRequest();
    m.pendingItems = { items: [{ id: decided.id, submittedAt: new Date() }], nextCursor: null };
    const api: { current: ReturnType<typeof useNextPendingReview> | null } = { current: null };
    renderWithProviders(<Harness id={decided.id} onReady={(v) => (api.current = v)} />);
    await vi.waitFor(() => expect(api.current).not.toBeNull());
    api.current?.openNext();
    await expect.element(page.getByTestId('apps-review-all-caught-up')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-review-all-caught-up'))
      .toHaveTextContent('All caught up');
    expect(router.push).not.toHaveBeenCalled();
  });

  test('the queue not loaded → back to the queue page, never a guessed "caught up"', async () => {
    const decided = pendingRequest();
    m.pendingItems = undefined;
    const api: { current: ReturnType<typeof useNextPendingReview> | null } = { current: null };
    renderWithProviders(<Harness id={decided.id} onReady={(v) => (api.current = v)} />);
    await vi.waitFor(() => expect(api.current).not.toBeNull());
    api.current?.openNext();
    expect(router.push).toHaveBeenCalledWith('/apps/review');
    expect(page.getByTestId('apps-review-all-caught-up').elements()).toHaveLength(0);
  });
});
