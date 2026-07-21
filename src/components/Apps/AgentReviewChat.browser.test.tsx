import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * AGENTIC MOD CODE-REVIEW in-modal CHAT (App Blocks P3) — browser-mode tests.
 *
 * The chat is a child of AgentReviewPanel, shown only while the agent POD is up
 * (status running | complete | cost-capped). Covers:
 *  - the visibility gate: hidden for failed / torn-down / no-report; visible for
 *    complete / running;
 *  - sending: appends the user message, calls agentReviewChat with the RUNNING
 *    conversation, renders the reply;
 *  - the input is disabled while a turn is in flight;
 *  - the error path renders inline WITHOUT losing the conversation;
 *  - the stored-XSS-at-render guard: an adversarial agent reply renders as inert
 *    TEXT (no live <img>/<script>, no side effects).
 */

const mocks = vi.hoisted(() => ({
  // Report row returned by getAgentReview (drives the panel + chat gate).
  agentReport: null as unknown,
  // agentReviewChat mutation control.
  chatReply: 'Because scope buzz:read is used in wallet.js:10.',
  chatError: undefined as { message: string } | undefined,
  chatPending: false,
  chatMutate: vi.fn(),
  invalidate: vi.fn().mockResolvedValue(undefined),
  startMutate: vi.fn(),
}));

const showError = vi.fn();
const showSuccess = vi.fn();
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: (...a: unknown[]) => showSuccess(...a),
  showErrorNotification: (...a: unknown[]) => showError(...a),
}));

vi.mock('~/utils/trpc', () => {
  const inert = { invalidate: mocks.invalidate };
  const utils = { blocks: { getAgentReview: inert } };
  return {
    trpc: {
      useUtils: () => utils,
      blocks: {
        getAgentReview: {
          useQuery: () => ({
            data: mocks.agentReport,
            isLoading: false,
            error: null,
            failureCount: 0,
            refetch: vi.fn(),
          }),
        },
        startAgentReview: {
          useMutation: (opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => ({
            mutate: (vars: unknown) => {
              mocks.startMutate(vars);
              void opts?.onSuccess?.();
            },
            isPending: false,
          }),
        },
        agentReviewChat: {
          useMutation: () => ({
            mutate: (
              vars: unknown,
              opts?: { onSuccess?: (d: { reply: string }) => void; onError?: (e: { message: string }) => void }
            ) => {
              mocks.chatMutate(vars);
              if (mocks.chatError) opts?.onError?.(mocks.chatError);
              else opts?.onSuccess?.({ reply: mocks.chatReply });
            },
            isPending: mocks.chatPending,
          }),
        },
      },
    },
  };
});

const { AgentReviewPanel } = await import('./AgentReviewPanel');

const COMPLETE_REPORT = {
  id: 'arar_1',
  status: 'complete',
  model: 'review-model-x',
  costUsd: '0.010000',
  summaryMd: 'looks reasonable',
  codeReview: { findings: [] },
  securityAudit: { findings: [] },
  scopeVerdicts: { scopes: [] },
};

beforeEach(() => {
  mocks.agentReport = null;
  mocks.chatReply = 'Because scope buzz:read is used in wallet.js:10.';
  mocks.chatError = undefined;
  mocks.chatPending = false;
  mocks.chatMutate.mockClear();
  mocks.invalidate.mockClear();
  mocks.startMutate.mockClear();
  showError.mockClear();
  showSuccess.mockClear();
});

const renderPanel = () =>
  renderWithProviders(<AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />);

// ---------------------------------------------------------------------------
// VISIBILITY GATE
// ---------------------------------------------------------------------------

describe('AgentReviewChat — visibility gate (via AgentReviewPanel)', () => {
  test('hidden when there is NO report (Run button shown, no chat)', async () => {
    mocks.agentReport = null;
    renderPanel();
    await expect.element(page.getByRole('button', { name: 'Run agentic review' })).toBeInTheDocument();
    expect(page.getByTestId('agent-review-chat').elements()).toHaveLength(0);
  });

  test('hidden when the report FAILED (no pod to talk to)', async () => {
    mocks.agentReport = { status: 'failed', summaryMd: 'the model errored' };
    renderPanel();
    await expect.element(page.getByText(/agentic review failed/)).toBeInTheDocument();
    expect(page.getByTestId('agent-review-chat').elements()).toHaveLength(0);
  });

  test('hidden when the report is TORN-DOWN', async () => {
    mocks.agentReport = { status: 'torn-down' };
    renderPanel();
    await expect.element(page.getByText(/Review was torn down/)).toBeInTheDocument();
    expect(page.getByTestId('agent-review-chat').elements()).toHaveLength(0);
  });

  test('visible when the report is COMPLETE (pod up)', async () => {
    mocks.agentReport = COMPLETE_REPORT;
    renderPanel();
    await expect.element(page.getByTestId('agent-review-chat')).toBeInTheDocument();
    await expect.element(page.getByText('Ask the review agent')).toBeInTheDocument();
  });

  test('visible while the report is still RUNNING (pod up)', async () => {
    mocks.agentReport = { status: 'running' };
    renderPanel();
    await expect.element(page.getByTestId('agent-review-chat')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// SEND
// ---------------------------------------------------------------------------

describe('AgentReviewChat — send', () => {
  test('sending appends the user message, calls agentReviewChat with the running conversation, and renders the reply', async () => {
    mocks.agentReport = COMPLETE_REPORT;
    renderPanel();

    await page.getByRole('textbox', { name: 'Ask the review agent' }).fill('why did you flag scope X?');
    await page.getByRole('button', { name: 'Send' }).click();

    // Mutation called with the id + the running conversation (the user turn).
    expect(mocks.chatMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        publishRequestId: 'onsite-req-1',
        messages: [{ role: 'user', content: 'why did you flag scope X?' }],
      })
    );
    // Both the user message and the agent reply render.
    await expect.element(page.getByText('why did you flag scope X?')).toBeInTheDocument();
    await expect
      .element(page.getByText('Because scope buzz:read is used in wallet.js:10.'))
      .toBeInTheDocument();
  });

  test('the input is disabled while a turn is in flight', async () => {
    mocks.agentReport = COMPLETE_REPORT;
    mocks.chatPending = true;
    renderPanel();
    await expect
      .element(page.getByRole('textbox', { name: 'Ask the review agent' }))
      .toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// ERROR PATH
// ---------------------------------------------------------------------------

describe('AgentReviewChat — error path', () => {
  test('an error renders inline WITHOUT losing the conversation', async () => {
    mocks.agentReport = COMPLETE_REPORT;
    renderPanel();

    // First turn succeeds.
    await page.getByRole('textbox', { name: 'Ask the review agent' }).fill('q1');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.element(page.getByText('q1')).toBeInTheDocument();
    await expect
      .element(page.getByText('Because scope buzz:read is used in wallet.js:10.'))
      .toBeInTheDocument();

    // Second turn errors.
    mocks.chatError = { message: 'the review agent did not respond' };
    await page.getByRole('textbox', { name: 'Ask the review agent' }).fill('q2');
    await page.getByRole('button', { name: 'Send' }).click();

    // Inline error shown, and the prior conversation is intact.
    await expect.element(page.getByText('the review agent did not respond')).toBeInTheDocument();
    await expect.element(page.getByText('q1')).toBeInTheDocument();
    await expect.element(page.getByText('q2')).toBeInTheDocument();
    await expect
      .element(page.getByText('Because scope buzz:read is used in wallet.js:10.'))
      .toBeInTheDocument();
    // No toast — the error is inline only.
    expect(showError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SANITIZATION (stored-XSS-at-render guard)
// ---------------------------------------------------------------------------

describe('AgentReviewChat — sanitization', () => {
  test('an adversarial agent reply renders as inert TEXT (no live <img>/<script>, no side effects)', async () => {
    const imgPayload = '<img src=x onerror="window.__chatXssFired=true">';
    const scriptPayload = '<script>window.__chatXssScript=true</script>';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__chatXssFired = undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__chatXssScript = undefined;

    mocks.agentReport = COMPLETE_REPORT;
    mocks.chatReply = `${imgPayload}${scriptPayload}`;
    renderPanel();

    await page.getByRole('textbox', { name: 'Ask the review agent' }).fill('give me a payload');
    await page.getByRole('button', { name: 'Send' }).click();

    // The raw markup is present as TEXT, not parsed into elements.
    expect(document.body.textContent).toContain(imgPayload);
    expect(document.body.textContent).toContain(scriptPayload);
    // No injected <img> element, and no live <script> executed.
    expect(document.querySelectorAll('img').length).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).__chatXssFired).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).__chatXssScript).toBeUndefined();
  });
});
