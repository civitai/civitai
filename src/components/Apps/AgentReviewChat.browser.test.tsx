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

// The agent bubble now renders through `CustomMarkdown`, which reads
// `useCurrentUser()` (→ CivitaiSessionContext) for its link-rewrite. The
// network-free scaffold has no session provider, so boundary-stub the hook (the
// standard pattern in the sibling Apps tests). Null user is fine — CustomMarkdown
// only uses `user?.id` (optional-chained).
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => null,
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
              if (mocks.chatError) {
                opts?.onError?.(mocks.chatError);
                return;
              }
              // Simulate the server-side zod cap: agentReviewChatSchema caps
              // `messages` at .max(20). If the client ever sends more, the real
              // proc rejects with a raw BAD_REQUEST validation string (the
              // dead-end the sliding window prevents).
              const msgs = (vars as { messages?: unknown[] }).messages ?? [];
              if (msgs.length > 20) {
                opts?.onError?.({
                  message:
                    '[{"code":"too_big","maximum":20,"path":["messages"],"message":"Array must contain at most 20 element(s)"}]',
                });
                return;
              }
              opts?.onSuccess?.({ reply: mocks.chatReply });
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
// SLIDING WINDOW (stay under the server .max(20) cap)
// ---------------------------------------------------------------------------

// The client sends `MAX_CHAT_HISTORY_SENT` (18) turns max; keep the assertions
// in sync with that constant without importing it (the mock module boundary).
const MAX_SENT = 18;

const sendTurn = async (text: string) => {
  await page.getByRole('textbox', { name: 'Ask the review agent' }).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
};

describe('AgentReviewChat — sliding window', () => {
  test('a >10-turn conversation stays under the server cap: mutation is called with <=18 messages and never dead-ends', async () => {
    mocks.agentReport = COMPLETE_REPORT;
    renderPanel();

    // 11 user turns → full history would be 21 messages (2N-1 = 21 > 20), which
    // would trip the server's .max(20) cap on the last turn. Each turn appends a
    // user message AND (via the mock) an assistant reply.
    for (let i = 1; i <= 11; i++) {
      await sendTurn(`question number ${i}`);
      // The reply for this turn rendered — the turn did NOT dead-end.
      await expect
        .element(page.getByText('Because scope buzz:read is used in wallet.js:10.').first())
        .toBeInTheDocument();
    }

    // Every mutation call sent a windowed payload (<= MAX_SENT), never the full
    // history — so the server cap can never be tripped.
    const calls = mocks.chatMutate.mock.calls as Array<[{ messages: unknown[] }]>;
    expect(calls.length).toBe(11);
    for (const [vars] of calls) {
      expect(vars.messages.length).toBeLessThanOrEqual(MAX_SENT);
    }
    // The LAST turn — the one that would have exceeded 20 unwindowed — was
    // clamped to exactly MAX_SENT.
    expect(calls[calls.length - 1][0].messages.length).toBe(MAX_SENT);

    // No raw validation error dead-ended the chat.
    expect(
      page.getByText(/Array must contain at most 20 element/).elements()
    ).toHaveLength(0);
    // The full scrollback is still in the UI (the mod sees everything): the very
    // first question is still rendered even though it dropped from the SENT slice.
    await expect.element(page.getByText('question number 1', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('question number 11', { exact: true })).toBeInTheDocument();
  });

  test('the "earlier messages omitted" note renders once history exceeds the cap, and is absent for a short chat', async () => {
    mocks.agentReport = COMPLETE_REPORT;
    renderPanel();

    // Short chat: one turn (2 messages) — note absent.
    await sendTurn('just one question');
    await expect
      .element(page.getByText('Because scope buzz:read is used in wallet.js:10.').first())
      .toBeInTheDocument();
    expect(page.getByTestId('chat-window-trim-note').elements()).toHaveLength(0);

    // Keep sending until the history exceeds MAX_SENT (18) → note appears.
    for (let i = 2; i <= 11; i++) {
      await sendTurn(`question number ${i}`);
    }
    await expect.element(page.getByTestId('chat-window-trim-note')).toBeInTheDocument();
    await expect
      .element(page.getByText(/Earlier messages are no longer included/))
      .toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// MARKDOWN RENDERING (agent replies format markdown, not literal markup)
// ---------------------------------------------------------------------------

describe('AgentReviewChat — markdown rendering', () => {
  test('an assistant reply renders markdown (bold / inline code / list) as real HTML, not literal markup', async () => {
    mocks.agentReport = COMPLETE_REPORT;
    // A reply exercising three markdown constructs at once.
    mocks.chatReply = 'Here is **bold text** and `inline code`.\n\n- first item\n- second item';
    renderPanel();

    await page.getByRole('textbox', { name: 'Ask the review agent' }).fill('format your answer');
    await page.getByRole('button', { name: 'Send' }).click();

    // Anchor on the mounted agent bubble before any sync DOM read (browser-mode
    // render is async-committed).
    const agentMsg = page.getByTestId('chat-agent-msg');
    await expect.element(agentMsg).toBeInTheDocument();

    // The markdown became actual HTML elements, scoped to the agent bubble.
    const bubble = document.querySelector('[data-testid="chat-agent-msg"]') as HTMLElement;
    expect(bubble.querySelector('strong')?.textContent).toBe('bold text');
    expect(bubble.querySelector('code')?.textContent).toBe('inline code');
    // The `- item` lines became a real bulleted list, not two literal dashes.
    expect(bubble.querySelectorAll('li').length).toBe(2);

    // The raw markdown SYNTAX is gone from the visible text — it was rendered,
    // not shown verbatim (the pre-fix plain-<Text> behavior).
    expect(bubble.textContent).not.toContain('**bold text**');
    expect(bubble.textContent).not.toContain('`inline code`');
  });

  test('a user-typed message stays plain text (markdown NOT interpreted)', async () => {
    mocks.agentReport = COMPLETE_REPORT;
    renderPanel();

    // User types markdown-ish syntax; it must render verbatim (no <strong>).
    await page.getByRole('textbox', { name: 'Ask the review agent' }).fill('why **this** scope?');
    await page.getByRole('button', { name: 'Send' }).click();

    const userMsg = page.getByTestId('chat-user-msg');
    await expect.element(userMsg).toBeInTheDocument();
    const userBubble = document.querySelector('[data-testid="chat-user-msg"]') as HTMLElement;
    // The literal `**` is preserved and NOT converted to a <strong>.
    expect(userBubble.textContent).toContain('why **this** scope?');
    expect(userBubble.querySelector('strong')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THEME-AWARE BUBBLES (light-dark() surfaces, not a fixed light-mode color)
// ---------------------------------------------------------------------------

describe('AgentReviewChat — theme-aware bubbles', () => {
  test('bubbles use theme-driven light-dark() surfaces (dark-scheme token present), not a hardcoded hex', async () => {
    mocks.agentReport = COMPLETE_REPORT;
    renderPanel();

    await page.getByRole('textbox', { name: 'Ask the review agent' }).fill('hello');
    await page.getByRole('button', { name: 'Send' }).click();

    const agentMsg = page.getByTestId('chat-agent-msg');
    await expect.element(agentMsg).toBeInTheDocument();

    const agentBubble = document.querySelector('[data-testid="chat-agent-msg"]') as HTMLElement;
    const userBubble = document.querySelector('[data-testid="chat-user-msg"]') as HTMLElement;
    const agentStyle = agentBubble.getAttribute('style') ?? '';
    const userStyle = userBubble.getAttribute('style') ?? '';

    // Agent bubble background flips with the color scheme via Mantine's
    // light-dark() — the dark-scheme surface token is present, so it is NOT the
    // old fixed light-mode `gray.1` that rendered near-white in dark mode.
    expect(agentStyle).toContain('light-dark(');
    expect(agentStyle).toContain('var(--mantine-color-dark-5)');
    // No hardcoded hex color leaked into the bubble style.
    expect(agentStyle).not.toMatch(/#[0-9a-fA-F]{3,6}/);

    // User bubble is likewise theme-driven (filled blue accent, light-dark()).
    expect(userStyle).toContain('light-dark(');
    expect(userStyle).toContain('var(--mantine-color-blue');
  });
});
