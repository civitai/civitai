import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * AGENTIC MOD CODE-REVIEW panel (App Blocks P2) — browser-mode component tests.
 *
 * Covers:
 *  - the render GATE (through OnsiteReviewModal): off when the client flag is
 *    off, off for mode!=='pending', off for external/connect, ON for onsite
 *    pending + flag on;
 *  - the trigger (Run agentic review → startAgentReview) incl. the CONFLICT
 *    "already running" path handled without crashing;
 *  - the lifecycle states (running spinner + poll wiring, complete/cost-capped
 *    render, failed + rerun, torn-down note);
 *  - full report rendering (code findings, security findings, the three must-flag
 *    callouts, the scope table incl. over-broad/under-declared, sensitive badge,
 *    evidence file:line);
 *  - defensive/empty rendering ("None found", no throw);
 *  - the stored-XSS-at-render guard (adversarial markup renders as inert TEXT).
 */

const mocks = vi.hoisted(() => ({
  // Client feature flags returned by the mocked provider (gate tests vary this).
  flags: { appBlocks: true, appBlocksAgenticReview: true } as Record<string, boolean>,
  // Report row returned by getAgentReview (null = no report yet → Run button).
  agentReport: null as unknown,
  agentLoading: false,
  // Consecutive failed-poll count surfaced by react-query (drives the ceiling).
  agentFailureCount: 0,
  refetch: vi.fn().mockResolvedValue(undefined),
  // getReviewStatus poll data for the sibling ReviewPreviewPanel (kept inert).
  reviewStatus: undefined as unknown,
  // Per-mutation error injected into the NEXT mutate() call's onError.
  mutationError: undefined as { message: string; data?: { code?: string } } | undefined,
  pending: false,
  mutate: vi.fn(),
  invalidate: vi.fn().mockResolvedValue(undefined),
  // Captures the options passed to getAgentReview.useQuery so poll wiring is asserted.
  lastAgentOpts: undefined as { refetchInterval?: (q: unknown) => unknown } | undefined,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.flags,
}));

// Stub the review host bridge (only reached by the sibling live-preview branch).
vi.mock('~/components/Apps/ReviewBlockPreviewHost', () => ({
  ReviewBlockPreviewHost: () => <div data-testid="review-host-stub" />,
}));

// The scope-verdicts section renders responsively off `useMediaQuery` (table +
// horizontal-scroll on desktop, stacked cards on narrow). The real viewport is
// non-deterministic in browser mode, so we importActual @mantine/hooks and
// override ONLY useMediaQuery — DEFAULT desktop (false); the narrow branch is
// only reached after forcing it per test (the BaseModelInput/WorkflowInput
// media-query pattern).
vi.mock('@mantine/hooks', async () => {
  const actual = await vi.importActual<typeof import('@mantine/hooks')>('@mantine/hooks');
  return { ...actual, useMediaQuery: vi.fn(() => false) };
});

const showError = vi.fn();
const showSuccess = vi.fn();
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: (...a: unknown[]) => showSuccess(...a),
  showErrorNotification: (...a: unknown[]) => showError(...a),
}));

// The Summary tab renders `summaryMd` through `CustomMarkdown`, which reads
// `useCurrentUser()` (→ CivitaiSessionContext) for its link-rewrite. The
// network-free scaffold has no session provider, so boundary-stub the hook (the
// standard pattern in the sibling AgentReviewChat test). Null user is fine —
// CustomMarkdown only uses `user?.id` (optional-chained).
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => null,
}));

vi.mock('~/utils/trpc', () => {
  const mutation =
    (name: string) =>
    (opts?: { onSuccess?: () => void; onError?: (e: { message: string }) => void }) => ({
      mutate: (vars: unknown) => {
        mocks.mutate(name, vars);
        if (mocks.mutationError) opts?.onError?.(mocks.mutationError);
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
      getAgentReview: inert,
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
        // P2 additions.
        getAgentReview: {
          useQuery: (_input: unknown, opts: { refetchInterval?: (q: unknown) => unknown }) => {
            mocks.lastAgentOpts = opts;
            return {
              data: mocks.agentReport,
              isLoading: mocks.agentLoading,
              error: null,
              failureCount: mocks.agentFailureCount,
              refetch: mocks.refetch,
            };
          },
        },
        startAgentReview: { useMutation: mutation('startAgentReview') },
        // P3 — the panel mounts <AgentReviewChat> when the pod is up (running/
        // complete/cost-capped); it calls agentReviewChat.useMutation. Stub it so
        // the P2 lifecycle/report/sanitization tests (which now render the chat)
        // don't crash. Chat behavior is covered in AgentReviewChat.browser.test.tsx.
        agentReviewChat: { useMutation: mutation('agentReviewChat') },
      },
    },
  };
});

const { AgentReviewPanel, AGENT_REVIEW_POLL_MS } = await import('./AgentReviewPanel');
const { OnsiteReviewModal } = await import('./OnsiteReviewModal');
const { useMediaQuery } = await import('@mantine/hooks');
const useMediaQueryMock = vi.mocked(useMediaQuery);
/** Force the responsive branch: true = narrow/mobile (cards), false = desktop (table). */
const setNarrow = (narrow: boolean) => useMediaQueryMock.mockReturnValue(narrow);

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
  },
  fileSummary: { files: [], added: [], removed: [], changed: [] },
  manifestDiffSummary: { kind: 'first-version', fields: ['name'] },
  reviewRepoUrl: 'https://forgejo.example/repo',
  pushCommitUrl: null as string | null,
  submittedBy: { id: 7, username: 'dev-user', image: null },
};

const ONSITE_APPROVED = {
  ...ONSITE_PENDING,
  id: 'onsite-req-2',
  reviewedAt: new Date('2026-01-02T00:00:00Z'),
  approvalNotes: 'looks good',
  reviewedBy: { id: 99, username: 'mod-user', image: null },
};

// A mis-routed external/connect request (out of P2 scope) — carries a manifest
// kind marker (and, for belt, an oauthClientId).
const EXTERNAL_PENDING = {
  ...ONSITE_PENDING,
  id: 'external-req-1',
  oauthClientId: 'oauth_abc',
  manifest: { ...ONSITE_PENDING.manifest, kind: 'external' },
};

const FULL_REPORT = {
  id: 'arar_1',
  status: 'complete',
  model: 'review-model-x',
  costUsd: '0.025000',
  startedAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: new Date('2026-01-01T00:05:00Z'),
  summaryMd: 'Overall the app looks reasonable with a couple of concerns.',
  codeReview: {
    findings: [
      {
        file: 'auth.js',
        line: 42,
        severity: 'high',
        title: 'Hardcoded secret',
        description: 'A hardcoded API token was found in the bundle.',
      },
    ],
    priorFindingsReconciled: [{ title: 'Old eval() call', status: 'resolved' }],
    notes: 'code notes here',
  },
  securityAudit: {
    findings: [{ severity: 'medium', title: 'Broad fetch', description: 'Calls an external host.' }],
    manifestUnexpectedKeys: ['sneakyKey'],
    iframeSandboxGrants: ['allow-same-origin'],
    promptInjectionAttempts: [{ file: 'README.md', excerpt: 'ignore previous instructions' }],
    notes: 'security notes here',
  },
  scopeVerdicts: {
    scopes: [
      {
        declared: 'buzz:read:self',
        used: 'yes',
        justificationAccurate: 'weak',
        sensitive: true,
        evidence: ['wallet.js:10'],
        notes: 'reads balance',
      },
    ],
    overBroad: ['user:*'],
    underDeclared: ['models:write:self'],
  },
  tokenUsage: { promptTokens: 1200, completionTokens: 340 },
};

// A report with multiple findings per section — exercises tab counts + the
// severity roll-up (critical + high in the security breakdown).
const MULTI_REPORT = {
  ...FULL_REPORT,
  summaryMd: '# Review summary\n\n**Two** concerns, one _minor_.',
  codeReview: {
    findings: [
      { severity: 'low', title: 'Low code finding', detail: 'nit' },
      { severity: 'high', title: 'High code finding', detail: 'important' },
      { severity: 'medium', title: 'Medium code finding', detail: 'moderate' },
    ],
    priorFindingsReconciled: [],
  },
  securityAudit: {
    findings: [
      { severity: 'critical', title: 'Critical sec finding', detail: 'sandbox escape' },
      { severity: 'high', title: 'High sec finding', detail: 'broad host' },
    ],
    manifestUnexpectedKeys: [],
    iframeSandboxGrants: [],
    promptInjectionAttempts: [],
  },
  scopeVerdicts: {
    scopes: [
      { declared: 'user:read', used: 'yes', justificationAccurate: 'yes', sensitive: false, evidence: [] },
      { declared: 'buzz:read:self', used: 'yes', justificationAccurate: 'weak', sensitive: true, evidence: [] },
    ],
    overBroad: [],
    underDeclared: [],
  },
};

// Only code findings, deliberately out of severity order — the render must sort
// them critical → info regardless of input order.
const SORT_REPORT = {
  status: 'complete',
  summaryMd: null,
  codeReview: {
    findings: [
      { severity: 'low', title: 'Low finding' },
      { severity: 'critical', title: 'Critical finding' },
      { severity: 'medium', title: 'Medium finding' },
    ],
  },
  securityAudit: {},
  scopeVerdicts: {},
};

beforeEach(() => {
  mocks.flags = { appBlocks: true, appBlocksAgenticReview: true };
  mocks.agentReport = null;
  mocks.agentLoading = false;
  mocks.agentFailureCount = 0;
  mocks.refetch.mockClear();
  mocks.reviewStatus = undefined;
  mocks.mutationError = undefined;
  mocks.pending = false;
  mocks.mutate.mockClear();
  mocks.invalidate.mockClear();
  mocks.lastAgentOpts = undefined;
  showError.mockClear();
  showSuccess.mockClear();
  setNarrow(false); // desktop (table + scroll-container) by default
});

// ---------------------------------------------------------------------------
// GATE (through the modal)
// ---------------------------------------------------------------------------

describe('AgentReviewPanel — render gate (through OnsiteReviewModal)', () => {
  test('does NOT render when the agentic-review client flag is off', async () => {
    mocks.flags = { appBlocks: true }; // flag absent → fails closed
    renderWithProviders(
      <OnsiteReviewModal selection={{ request: ONSITE_PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    // Sibling review-preview panel still renders (sanity that the modal mounted).
    await expect.element(page.getByText('Review preview')).toBeInTheDocument();
    // The agentic panel is absent.
    expect(page.getByText('Agentic code review').elements()).toHaveLength(0);
  });

  test('does NOT render for a non-pending (approved) selection even with the flag on', async () => {
    renderWithProviders(
      <OnsiteReviewModal selection={{ request: ONSITE_APPROVED, mode: 'approved' }} onClose={vi.fn()} />
    );
    await expect.element(page.getByText('looks good')).toBeInTheDocument();
    expect(page.getByText('Agentic code review').elements()).toHaveLength(0);
  });

  test('does NOT render for an external/connect request even on an onsite pending flow', async () => {
    renderWithProviders(
      <OnsiteReviewModal selection={{ request: EXTERNAL_PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    // The pending body mounted (Review preview shows), but the agentic panel is hidden.
    await expect.element(page.getByText('Review preview')).toBeInTheDocument();
    expect(page.getByText('Agentic code review').elements()).toHaveLength(0);
  });

  test('DOES render for an onsite pending request with the flag on', async () => {
    renderWithProviders(
      <OnsiteReviewModal selection={{ request: ONSITE_PENDING, mode: 'pending' }} onClose={vi.fn()} />
    );
    await expect.element(page.getByText('Agentic code review')).toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Run agentic review' }))
      .toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// TRIGGER
// ---------------------------------------------------------------------------

describe('AgentReviewPanel — trigger', () => {
  test('clicking "Run agentic review" fires startAgentReview with the request id', async () => {
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);
    await page.getByRole('button', { name: 'Run agentic review' }).click();
    expect(mocks.mutate).toHaveBeenCalledWith(
      'startAgentReview',
      expect.objectContaining({ publishRequestId: 'onsite-req-1' })
    );
    // Success path invalidates the read query (no error surfaced).
    expect(showError).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  test('a CONFLICT "already running" error is handled gracefully (no error crash, refetches)', async () => {
    mocks.mutationError = {
      message: 'a review is already running for this request',
      data: { code: 'CONFLICT' },
    };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);
    await page.getByRole('button', { name: 'Run agentic review' }).click();
    // No error notification (CONFLICT is expected), and the read query is refetched
    // so the panel falls into the running state.
    expect(showError).not.toHaveBeenCalled();
    expect(showSuccess).toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  test('a genuine error DOES surface via showErrorNotification', async () => {
    mocks.mutationError = { message: 'boom', data: { code: 'BAD_REQUEST' } };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);
    await page.getByRole('button', { name: 'Run agentic review' }).click();
    expect(showError).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Could not start agentic review' })
    );
  });
});

// ---------------------------------------------------------------------------
// LIFECYCLE STATES
// ---------------------------------------------------------------------------

describe('AgentReviewPanel — lifecycle states', () => {
  test('running: shows the spinner + "Analyzing…" and the poll is wired (stops on terminal)', async () => {
    mocks.agentReport = { status: 'running' };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);
    await expect.element(page.getByText(/Analyzing/)).toBeInTheDocument();
    // The run button is NOT shown while running.
    expect(page.getByRole('button', { name: 'Run agentic review' }).elements()).toHaveLength(0);
    // Poll wiring: refetchInterval polls while running, stops on every terminal state.
    const ri = mocks.lastAgentOpts?.refetchInterval as (q: unknown) => unknown;
    expect(ri({ state: { data: { status: 'running' } } })).toBe(AGENT_REVIEW_POLL_MS);
    expect(ri({ state: { data: { status: 'complete' } } })).toBe(false);
    expect(ri({ state: { data: { status: 'failed' } } })).toBe(false);
    expect(ri({ state: { data: undefined } })).toBe(false);
  });

  test('complete: renders the report (advisory banner + a code finding)', async () => {
    mocks.agentReport = FULL_REPORT;
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);
    await expect.element(page.getByText(/Advisory only/)).toBeInTheDocument();
    await expect.element(page.getByText('Hardcoded secret')).toBeInTheDocument();
  });

  test('cost-capped: renders the report with the cost-capped marker', async () => {
    mocks.agentReport = { ...FULL_REPORT, status: 'cost-capped' };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);
    await expect.element(page.getByText(/Advisory only/)).toBeInTheDocument();
    expect(page.getByText('cost-capped').elements().length).toBeGreaterThan(0);
  });

  test('failed: shows the error state + a "Run again" affordance', async () => {
    mocks.agentReport = { status: 'failed', summaryMd: 'the model errored' };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);
    await expect.element(page.getByText(/agentic review failed/)).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Run again' })).toBeInTheDocument();
  });

  test('torn-down: shows the torn-down note + rerun', async () => {
    mocks.agentReport = { status: 'torn-down' };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);
    await expect.element(page.getByText(/Review was torn down/)).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Run again' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// POLL CEILING — manual "Check again" fallback
// ---------------------------------------------------------------------------

describe('AgentReviewPanel — poll ceiling / manual refresh', () => {
  test('a stuck `running` run past the error ceiling pauses auto-refresh and offers "Check again", which refetches', async () => {
    // Still `running`, but the poll has been failing consecutively past the
    // threshold → auto-refresh is paused (no spinner) and a manual affordance shows.
    mocks.agentReport = { status: 'running' };
    mocks.agentFailureCount = 3; // >= MAX_CONSECUTIVE_POLL_ERRORS
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);

    await expect.element(page.getByText(/automatic updates paused/)).toBeInTheDocument();
    // The spinning "Analyzing…" state is NOT shown while paused.
    expect(page.getByText(/^Analyzing/).elements()).toHaveLength(0);

    // Clicking "Check again" triggers a refetch (resuming the poll).
    await page.getByRole('button', { name: 'Check again' }).click();
    expect(mocks.refetch).toHaveBeenCalled();
  });

  test('a single transient poll failure does NOT pause — the spinner keeps showing', async () => {
    mocks.agentReport = { status: 'running' };
    mocks.agentFailureCount = 1; // 1 < MAX_CONSECUTIVE_POLL_ERRORS → keep polling
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);
    await expect.element(page.getByText(/Analyzing/)).toBeInTheDocument();
    expect(page.getByText(/automatic updates paused/).elements()).toHaveLength(0);
    expect(page.getByRole('button', { name: 'Check again' }).elements()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FULL REPORT RENDERING
// ---------------------------------------------------------------------------

describe('AgentReviewPanel — report rendering', () => {
  test('a fully-populated report renders code + security findings, the three must-flag callouts, and the scope table', async () => {
    mocks.agentReport = FULL_REPORT;
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);

    // Advisory banner (required).
    await expect.element(page.getByText(/Advisory only/)).toBeInTheDocument();
    // Header meta.
    await expect.element(page.getByText('review-model-x')).toBeInTheDocument();
    await expect.element(page.getByText('$0.0250')).toBeInTheDocument();

    // Code review — file:line + severity + description + prior-version reconciliation.
    await expect.element(page.getByText('Hardcoded secret')).toBeInTheDocument();
    await expect.element(page.getByText('auth.js:42')).toBeInTheDocument();
    await expect
      .element(page.getByText('A hardcoded API token was found in the bundle.'))
      .toBeInTheDocument();
    await expect.element(page.getByText('Prior-version reconciliation')).toBeInTheDocument();
    await expect.element(page.getByText('Old eval() call')).toBeInTheDocument();

    // Security — the three MUST-FLAG callouts, rendered prominently.
    await expect.element(page.getByText('Broad fetch')).toBeInTheDocument();
    await expect.element(page.getByText('Unexpected manifest keys')).toBeInTheDocument();
    await expect.element(page.getByText('sneakyKey')).toBeInTheDocument();
    await expect.element(page.getByText('Risky iframe sandbox grants')).toBeInTheDocument();
    await expect.element(page.getByText('allow-same-origin')).toBeInTheDocument();
    await expect.element(page.getByText('Prompt-injection attempts')).toBeInTheDocument();
    await expect.element(page.getByText('ignore previous instructions')).toBeInTheDocument();

    // Scope verdicts table — one row + over-broad + under-declared + sensitive + evidence.
    await expect.element(page.getByTestId('scope-verdicts-table')).toBeInTheDocument();
    await expect.element(page.getByText('buzz:read:self')).toBeInTheDocument();
    await expect.element(page.getByTestId('scope-sensitive-badge')).toBeInTheDocument();
    await expect.element(page.getByText('wallet.js:10')).toBeInTheDocument();
    await expect.element(page.getByText('Over-broad scopes')).toBeInTheDocument();
    await expect.element(page.getByText('user:*')).toBeInTheDocument();
    await expect.element(page.getByText('Under-declared scopes')).toBeInTheDocument();
    await expect.element(page.getByText('models:write:self')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// RESPONSIVE SCOPE-VERDICTS (table + horizontal-scroll desktop / stacked cards)
// ---------------------------------------------------------------------------

describe('AgentReviewPanel — responsive scope verdicts', () => {
  test('desktop: renders the verdicts table inside a horizontal-scroll container (not the card variant)', async () => {
    setNarrow(false);
    mocks.agentReport = FULL_REPORT;
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);

    // The scroll container wraps the table so long scope/evidence columns scroll
    // horizontally instead of squishing.
    await expect.element(page.getByTestId('scope-verdicts-scroll')).toBeInTheDocument();
    await expect.element(page.getByTestId('scope-verdicts-table')).toBeInTheDocument();
    // The narrow stacked-card variant is NOT rendered on desktop.
    expect(page.getByTestId('scope-verdicts-cards').elements()).toHaveLength(0);

    // Same data — every scope row, the sensitive badge, and evidence still render.
    await expect.element(page.getByText('buzz:read:self')).toBeInTheDocument();
    await expect.element(page.getByTestId('scope-sensitive-badge')).toBeInTheDocument();
    await expect.element(page.getByText('wallet.js:10')).toBeInTheDocument();
  });

  test('narrow/mobile: renders stacked per-scope cards instead of the table (same data)', async () => {
    setNarrow(true);
    mocks.agentReport = FULL_REPORT;
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);

    // The card variant renders; the table + its scroll container do NOT.
    await expect.element(page.getByTestId('scope-verdicts-cards')).toBeInTheDocument();
    expect(page.getByTestId('scope-verdicts-table').elements()).toHaveLength(0);
    expect(page.getByTestId('scope-verdicts-scroll').elements()).toHaveLength(0);

    // The card layout carries the same label/value data — scope id, the sensitive
    // badge, evidence, and the label rows.
    await expect.element(page.getByText('buzz:read:self')).toBeInTheDocument();
    await expect.element(page.getByTestId('scope-sensitive-badge')).toBeInTheDocument();
    await expect.element(page.getByText('wallet.js:10')).toBeInTheDocument();
    // The stacked-card label rows (present only in the card variant).
    expect(page.getByText('Justified').elements().length).toBeGreaterThan(0);
    expect(page.getByText('Evidence').elements().length).toBeGreaterThan(0);
  });

  test('narrow/mobile: empty scopes still shows the "No scopes assessed" empty state', async () => {
    setNarrow(true);
    mocks.agentReport = { ...FULL_REPORT, scopeVerdicts: { scopes: [], overBroad: [], underDeclared: [] } };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);
    await expect.element(page.getByText('No scopes assessed')).toBeInTheDocument();
    expect(page.getByTestId('scope-verdicts-cards').elements()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DEFENSIVE / EMPTY
// ---------------------------------------------------------------------------

describe('AgentReviewPanel — defensive / empty', () => {
  test('a report with empty/missing sub-objects renders per-tab empty states without throwing', async () => {
    mocks.agentReport = {
      status: 'complete',
      model: null,
      costUsd: null,
      codeReview: null,
      securityAudit: undefined,
      scopeVerdicts: {},
    };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);
    // The report still renders (advisory banner) and each tab has a tidy empty state.
    // (Panels are keepMounted, so all four are in the DOM regardless of active tab.)
    await expect.element(page.getByText(/Advisory only/)).toBeInTheDocument();
    await expect.element(page.getByText('No code-review findings.')).toBeInTheDocument();
    await expect.element(page.getByText('No security-audit findings.')).toBeInTheDocument();
    await expect.element(page.getByText('No scopes assessed.')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// SANITIZATION (stored-XSS-at-render guard)
// ---------------------------------------------------------------------------

describe('AgentReviewPanel — sanitization', () => {
  test('adversarial HTML/script in finding text + summary renders as inert TEXT (no live DOM)', async () => {
    const imgPayload = '<img src=x onerror="window.__xssFired=true">';
    const scriptPayload = '<script>window.__xssScript=true</script>';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__xssFired = undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__xssScript = undefined;

    mocks.agentReport = {
      status: 'complete',
      summaryMd: scriptPayload,
      codeReview: { findings: [{ title: 'XSS attempt', description: imgPayload }] },
      securityAudit: {},
      scopeVerdicts: {},
    };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);

    // The finding still renders (its title is present).
    await expect.element(page.getByText('XSS attempt')).toBeInTheDocument();

    // The raw markup is present as TEXT, not parsed into elements.
    expect(document.body.textContent).toContain(imgPayload);
    expect(document.body.textContent).toContain(scriptPayload);
    // No injected <img> element was created from the payload, and no live <script>
    // with the payload body executed.
    expect(document.querySelectorAll('img').length).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).__xssFired).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).__xssScript).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TABBED REPORT IA (Phase-2 redesign)
// ---------------------------------------------------------------------------

describe('AgentReviewPanel — tabbed report', () => {
  test('renders the four tabs with finding counts in the labels', async () => {
    mocks.agentReport = MULTI_REPORT;
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);

    // Tab labels carry the counts (3 code findings, 2 security, 2 scopes).
    await expect.element(page.getByRole('tab', { name: /Summary/ })).toBeInTheDocument();
    await expect.element(page.getByRole('tab', { name: /Code review.*3/ })).toBeInTheDocument();
    await expect.element(page.getByRole('tab', { name: /Security audit.*2/ })).toBeInTheDocument();
    await expect.element(page.getByRole('tab', { name: /Scopes.*2/ })).toBeInTheDocument();

    // Summary roll-up shows the severity breakdown for security (1 critical, 1 high).
    const rollup = page.getByTestId('report-rollup');
    await expect.element(rollup).toBeVisible();
    await expect.element(rollup.getByText(/Code 3/)).toBeInTheDocument();
    await expect.element(rollup.getByText(/Security 2 \(1 critical, 1 high\)/)).toBeInTheDocument();
    await expect.element(rollup.getByText(/2 scopes/)).toBeInTheDocument();
  });

  test('switching tabs reveals the right section (one visible at a time)', async () => {
    mocks.agentReport = FULL_REPORT;
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);

    // Summary is the default active tab; its markdown panel is visible.
    await expect.element(page.getByTestId('report-summary-md')).toBeVisible();
    // Code-review-only content exists (keepMounted) but is NOT visible yet.
    await expect.element(page.getByText('Prior-version reconciliation')).not.toBeVisible();

    // Activate the Code review tab → its content becomes visible, Summary hides.
    await page.getByRole('tab', { name: /Code review/ }).click();
    await expect.element(page.getByText('Prior-version reconciliation')).toBeVisible();
    await expect.element(page.getByText('Hardcoded secret')).toBeVisible();
    await expect.element(page.getByTestId('report-summary-md')).not.toBeVisible();

    // Activate the Scopes tab → the verdicts table becomes visible.
    await page.getByRole('tab', { name: /Scopes/ }).click();
    await expect.element(page.getByTestId('scope-verdicts-table')).toBeVisible();
    await expect.element(page.getByText('Prior-version reconciliation')).not.toBeVisible();
  });

  test('findings render as cards sorted by severity (critical → info) regardless of input order', async () => {
    mocks.agentReport = SORT_REPORT;
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);

    // Activate the Code review tab and await a rendered card before the
    // synchronous elements() read — browser-mode render is async-committed, so a
    // bare sync query races the commit (was returning 0).
    await page.getByRole('tab', { name: /Code review/ }).click();
    await expect.element(page.getByText('Critical finding')).toBeVisible();

    // SORT_REPORT has only code findings, so every finding-card is a code card.
    const cards = page.getByTestId('finding-card').elements();
    expect(cards.length).toBe(3);
    const texts = cards.map((c) => c.textContent ?? '');
    // Input order was low, critical, medium → rendered order must be critical, medium, low.
    expect(texts[0]).toContain('Critical finding');
    expect(texts[1]).toContain('Medium finding');
    expect(texts[2]).toContain('Low finding');
  });

  test('summaryMd renders as markdown, and a markdown image is dropped (no <img>)', async () => {
    mocks.agentReport = {
      ...FULL_REPORT,
      summaryMd: '# Heading one\n\n**bolded** text with an ![alt](https://evil.example/pixel.png)',
    };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);

    // Markdown formatting is applied (heading + strong become real elements).
    await expect.element(page.getByRole('heading', { name: 'Heading one' })).toBeInTheDocument();
    expect(document.querySelector('.markdown-content strong')?.textContent).toBe('bolded');
    // 🔴 img-guard (mirrors the Phase-0 chat guard): the markdown image produces
    // NO <img> — an <img> would fire an external fetch from the moderator's browser.
    expect(document.querySelectorAll('img').length).toBe(0);
  });

  test('an errored analysis section shows the failure state, not a crash', async () => {
    mocks.agentReport = {
      status: 'complete',
      summaryMd: 'ok',
      // codeReview came back as an { error } object (sub-analysis failed).
      codeReview: { error: 'code analysis timed out' },
      securityAudit: { findings: [{ severity: 'high', title: 'A sec finding' }] },
      scopeVerdicts: {},
    };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);

    // The report still mounts (advisory banner present) — no crash.
    await expect.element(page.getByText(/Advisory only/)).toBeInTheDocument();

    // The Code review tab shows an explicit "analysis failed" state with the message.
    await page.getByRole('tab', { name: /Code review/ }).click();
    await expect.element(page.getByText('Analysis failed')).toBeVisible();
    await expect.element(page.getByText('code analysis timed out')).toBeVisible();

    // The intact security section still renders its finding.
    await page.getByRole('tab', { name: /Security audit/ }).click();
    await expect.element(page.getByText('A sec finding')).toBeVisible();
  });

  test('per-tab empty states render for a report with no findings/scopes', async () => {
    mocks.agentReport = {
      status: 'complete',
      summaryMd: null,
      codeReview: { findings: [] },
      securityAudit: { findings: [] },
      scopeVerdicts: { scopes: [] },
    };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);

    await expect.element(page.getByText('No code-review findings.')).toBeInTheDocument();
    await expect.element(page.getByText('No security-audit findings.')).toBeInTheDocument();
    await expect.element(page.getByText('No scopes assessed.')).toBeInTheDocument();
    // Summary tab with no summaryMd shows its own empty state.
    await expect.element(page.getByText('No summary was provided.')).toBeInTheDocument();
  });
});
