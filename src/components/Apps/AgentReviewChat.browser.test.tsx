import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import { neutralizeChatMarkup } from '~/shared/constants/review-agent-chat.constants';

/**
 * The review agent chat, in the browser: the REAL `<civitai-chat>` element (its agent loop,
 * `marked` + DOMPurify rendering), with only the network stubbed. Covers:
 *  - when the panel shows it (anything persisted to ground on);
 *  - that it starts on a host backend pointed at the review endpoint, with no `app`, and sends
 *    each request there naming the publish request and the report on screen;
 *  - that an adversarial reply cannot load a remote resource or run script: no `<img>` from
 *    markdown or raw HTML, and no `background` image (DOMPurify keeps that attribute, which is
 *    why the endpoint neutralizes markup; the positive control shows the element would render it).
 */

const mocks = vi.hoisted(() => ({
  agentReport: null as unknown,
  invalidate: vi.fn().mockResolvedValue(undefined),
}));

/*
  🔴 SPREAD THE ORIGINAL, never a one-key factory: a factory that omits an export fails the
  WHOLE FILE at import, reported as 0 tests collected (`local-rules/no-wholesale-module-mock`).
*/
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  // Only the panel's report read is measured; every other procedure answers inertly.
  trpc: makeTrpcProxy(
    {
      'blocks.getAgentReview': {
        useQuery: () => ({
          data: mocks.agentReport,
          isLoading: false,
          error: null,
          failureCount: 0,
          refetch: vi.fn(),
        }),
      },
      'blocks.listAgentReviews': { useQuery: () => ({ data: [] }) },
      'blocks.getAgentReviewModels': {
        useQuery: () => ({ data: { available: true, models: [] } }),
      },
    },
    {
      useUtils: () => ({
        blocks: {
          getAgentReview: { invalidate: mocks.invalidate },
          listAgentReviews: { invalidate: mocks.invalidate },
        },
      }),
    }
  ),
}));

const { AgentReviewPanel } = await import('./AgentReviewPanel');
const { AgentReviewChat } = await import('./AgentReviewChat');

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

type ChatEl = HTMLElement & {
  app?: unknown;
  backend?: { url: string; model: string; models?: unknown; store: unknown };
  systemPrompt?: unknown;
  send(text: string): Promise<void>;
};
const chatEl = () => document.querySelector('civitai-chat') as ChatEl | null;

/** Every element under `node`, through its shadow roots. */
function allElements(node: Node, out: Element[] = []): Element[] {
  if (node instanceof Element) out.push(node);
  const root = (node as Element).shadowRoot;
  if (root) allElements(root, out);
  for (const child of node.childNodes) allElements(child, out);
  return out;
}
const shownText = (node: Node): string =>
  allElements(node)
    .flatMap((el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE))
    .map((n) => n.textContent ?? '')
    .join('');

/** One streamed answer, in the chat-completions format the endpoint sends. */
const sse = (text: string) =>
  new Response(
    [
      { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
      .map(
        (c) =>
          `data: ${JSON.stringify({
            id: 'r',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'review-agent',
            ...c,
          })}\n\n`
      )
      .join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  );

type Sent = {
  url: string;
  headers: Headers;
  credentials?: RequestCredentials;
  body: Record<string, unknown>;
};
function stubEndpoint(answer: string) {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ url, headers: new Headers(init?.headers), credentials: init?.credentials, body });
    if (body.stream !== true)
      return Response.json({
        choices: [{ index: 0, message: { role: 'assistant', content: '' } }],
      });
    return sse(answer);
  });
  return sent;
}

async function mountChat(reportId = 'arar_1') {
  renderWithProviders(<AgentReviewChat publishRequestId="pubreq_A" reportId={reportId} />);
  await vi.waitFor(() => expect(chatEl()?.backend).toBeDefined(), { timeout: 10_000 });
  return chatEl()!;
}

const PIXEL = '/__review_chat_pixel.gif';
const pixelRequests = (tag: string) =>
  performance.getEntriesByType('resource').filter((e) => e.name.includes(`${PIXEL}?${tag}`));

beforeEach(() => {
  mocks.agentReport = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentReviewChat — when the panel shows it', () => {
  const renderPanel = () =>
    renderWithProviders(
      <AgentReviewPanel publishRequestId="onsite-req-1" slug="my-onsite-block" />
    );

  test('hidden when there is NO report', async () => {
    renderPanel();
    await expect
      .element(page.getByRole('button', { name: 'Run agentic review' }))
      .toBeInTheDocument();
    expect(page.getByTestId('agent-review-chat').elements()).toHaveLength(0);
  });

  test('hidden when the report is TORN-DOWN', async () => {
    mocks.agentReport = { status: 'torn-down' };
    renderPanel();
    await expect.element(page.getByText(/Review was torn down/)).toBeInTheDocument();
    expect(page.getByTestId('agent-review-chat').elements()).toHaveLength(0);
  });

  test('shown for a COMPLETE report, as the chat element', async () => {
    mocks.agentReport = COMPLETE_REPORT;
    renderPanel();
    await expect.element(page.getByTestId('agent-review-chat')).toBeInTheDocument();
    await vi.waitFor(() => expect(chatEl()?.backend).toBeDefined(), { timeout: 10_000 });
  });
});

describe('AgentReviewChat — the element and its backend', () => {
  test('starts on the review endpoint with no `app`, its own scope and only the allowlisted model', async () => {
    const el = await mountChat();
    expect(el.backend).toMatchObject({ url: '/api/mod/apps/review-agent', model: 'review-agent' });
    expect(el.backend!.models).toBeUndefined();
    expect(el.app).toBeUndefined();
    expect(el.getAttribute('scope')).toBe('app-review-agent');
  });

  test('sends each request to the endpoint, naming the publish request and the report on screen', async () => {
    const sent = stubEndpoint('Because scope buzz:read is used in wallet.js:10.');
    const el = await mountChat('arar_old');
    await el.send('why did you flag scope X?');
    await vi.waitFor(
      () => expect(shownText(el)).toContain('Because scope buzz:read is used in wallet.js:10.'),
      { timeout: 10_000 }
    );
    const reply = sent.find((s) => s.body.stream === true)!;
    expect(reply.url).toBe(`${location.origin}/api/mod/apps/review-agent/v1/chat/completions`);
    expect(reply.headers.get('x-review-publish-request-id')).toBe('pubreq_A');
    expect(reply.headers.get('x-review-report-id')).toBe('arar_old');
    expect(reply.credentials).toBe('same-origin');
    expect(reply.body.model).toBe('review-agent');
    // Every request names the request, the title's included.
    expect(sent.every((s) => s.headers.get('x-review-publish-request-id') === 'pubreq_A')).toBe(
      true
    );
  });
});

describe('AgentReviewChat — adversarial replies', () => {
  test('POSITIVE CONTROL: un-neutralized, the element renders a table cell `background`, which the browser fetches', async () => {
    stubEndpoint(`<table background="${PIXEL}?raw"><tr><td>cell</td></tr></table>`);
    const el = await mountChat();
    await el.send('payload');
    await vi.waitFor(() => expect(shownText(el)).toContain('cell'), { timeout: 10_000 });
    expect(allElements(el).filter((e) => e.hasAttribute('background'))).toHaveLength(1);
    await vi.waitFor(() => expect(pixelRequests('raw').length).toBeGreaterThan(0), {
      timeout: 5000,
    });
  });

  test('as the endpoint sends it, no image, background, table or script comes alive, and nothing is fetched', async () => {
    (window as unknown as { __reviewChatXss?: boolean }).__reviewChatXss = undefined;
    const adversarial = [
      `![tracking](${PIXEL}?md)`,
      `<img src="${PIXEL}?img" onerror="window.__reviewChatXss=true">`,
      `<table background="${PIXEL}?bg"><tr><td>cell</td></tr></table>`,
      '<script>window.__reviewChatXss=true</script>',
      'END',
    ].join('\n\n');
    stubEndpoint(neutralizeChatMarkup(adversarial));
    const el = await mountChat();
    await el.send('payload');
    await vi.waitFor(() => expect(shownText(el)).toContain('END'), { timeout: 10_000 });

    const elements = allElements(el);
    expect(elements.filter((e) => e.localName === 'img')).toHaveLength(0);
    expect(
      elements.filter((e) => e.localName === 'table' || e.localName === 'script')
    ).toHaveLength(0);
    expect(elements.filter((e) => e.hasAttribute('background'))).toHaveLength(0);
    // The raw markup reads as text instead.
    expect(shownText(el).replace(/\u200B/g, '')).toContain(`<table background="${PIXEL}?bg">`);
    // Give a fetch the same chance the positive control's had.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect([...pixelRequests('md'), ...pixelRequests('img'), ...pixelRequests('bg')]).toHaveLength(
      0
    );
    expect((window as unknown as { __reviewChatXss?: boolean }).__reviewChatXss).toBeUndefined();
  });

  test('markdown still formats', async () => {
    stubEndpoint(neutralizeChatMarkup('**bold** and `a < b` in\n\n- one\n- two'));
    const el = await mountChat();
    await el.send('format');
    await vi.waitFor(() => expect(shownText(el)).toContain('bold'), { timeout: 10_000 });
    const elements = allElements(el);
    expect(elements.some((e) => e.localName === 'strong' && e.textContent === 'bold')).toBe(true);
    // Leaf items only: the thread's own list holds each turn as an item too.
    const items = elements.filter((e) => e.localName === 'li' && e.children.length === 0);
    expect(items.map((e) => e.textContent)).toEqual(['one', 'two']);
    const code = elements.find((e) => e.localName === 'code');
    expect(code?.textContent?.replace(/\u200B/g, '')).toBe('a < b');
  });
});
