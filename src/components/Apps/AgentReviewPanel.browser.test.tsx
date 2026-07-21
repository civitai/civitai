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

const showError = vi.fn();
const showSuccess = vi.fn();
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: (...a: unknown[]) => showSuccess(...a),
  showErrorNotification: (...a: unknown[]) => showError(...a),
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
      },
    },
  };
});

const { AgentReviewPanel, AGENT_REVIEW_POLL_MS } = await import('./AgentReviewPanel');
const { OnsiteReviewModal } = await import('./OnsiteReviewModal');

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
// DEFENSIVE / EMPTY
// ---------------------------------------------------------------------------

describe('AgentReviewPanel — defensive / empty', () => {
  test('a report with empty/missing sub-objects renders "None found" for each section without throwing', async () => {
    mocks.agentReport = {
      status: 'complete',
      model: null,
      costUsd: null,
      codeReview: null,
      securityAudit: undefined,
      scopeVerdicts: {},
    };
    renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);
    // The report still renders (advisory banner) and the empty sections are tidy.
    await expect.element(page.getByText(/Advisory only/)).toBeInTheDocument();
    // Code + security findings both show "None found".
    expect(page.getByText('None found').elements().length).toBeGreaterThanOrEqual(2);
    // Scopes section shows its own empty label.
    await expect.element(page.getByText('No scopes assessed')).toBeInTheDocument();
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
