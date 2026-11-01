import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChatTool, ChatToolResult } from '@civitai/components-chat/civitai-chat';
import {
  APP_ASSISTANT_TURN_TOOL_CALL_LIMIT,
  createAssistantGate,
} from '~/components/Apps/AppAssistant/assistantGate';
import type { AssistantTokenProvider } from '~/components/Apps/AppAssistant/assistantToken';
import type * as ConfigMod from '~/components/Apps/AppAssistant/assistantChatConfig';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// The real chat element and its agent loop; only the SDK client and the network are stubbed.
const { anything } = vi.hoisted(() => {
  const anything: unknown = new Proxy(() => undefined, {
    get: (_target, key) => (key === 'then' ? undefined : anything),
    apply: () => Promise.reject(new Error('not available in this test')),
  });
  return { anything };
});
vi.mock('@civitai/sdk', () => ({
  initialize: vi.fn(async () => ({
    getToken: async () => 'chat-token',
    requestGrants: async () => true,
    viewer: { username: 'tester' },
    site: anything,
    orchestration: anything,
  })),
}));
// Civitai's own MCP servers are out of reach here; the page's tool is enough to reach the gate.
vi.mock('~/components/Apps/AppAssistant/assistantChatConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigMod>()),
  APP_ASSISTANT_MCP: { orchestration: false, site: false },
}));

const { AppAssistantChat } = await import('./AppAssistantChat');

const tokens: AssistantTokenProvider = {
  getToken: async () => 'chat-token',
  enable: async () => 'chat-token',
};

/** One streamed model answer, in the OpenAI chat-completions format the chat's provider reads. */
function sse(chunks: object[]): Response {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'];
  return new Response(body.join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}
const chunk = (delta: object, finish: string | null = null) => ({
  id: 'r',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/** Every model request a reply makes asks with tools; anything else (a title, a lookup) does not count. */
function stubModel(answer: (request: number) => Response) {
  const replyRequests: number[] = [];
  /** The `model` of every chat request, the title's included, in order. */
  const models: unknown[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith('/v1/chat/completions')) return new Response('{}', { status: 404 });
    const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown[]; model?: unknown };
    models.push(body.model);
    if (!body.tools?.length) return sse([chunk({ content: 'A title' }, 'stop')]);
    replyRequests.push(replyRequests.length + 1);
    return answer(replyRequests.length);
  });
  return { replyRequests, models, restore: () => vi.stubGlobal('fetch', realFetch) };
}

/** A step that calls the `noop` tool `count` times at once. */
const callNoop = (count: number) =>
  sse([
    chunk({
      role: 'assistant',
      tool_calls: Array.from({ length: count }, (_, i) => ({
        index: i,
        id: `call_${i}`,
        type: 'function',
        function: { name: 'noop', arguments: '{}' },
      })),
    }),
    chunk({}, 'tool_calls'),
  ]);
const sayDone = () => sse([chunk({ role: 'assistant', content: 'Done.' }), chunk({}, 'stop')]);

const LIMIT_MESSAGE =
  'App Assistant stopped this reply after 150 tool calls, the most one reply may make. Press Continue to let it carry on.';

type ChatEl = HTMLElement & { app?: unknown; send(text: string): Promise<void> };

/** Everything the chat shows, its shadow roots included. */
function shownText(node: Node): string {
  let text = node.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : '';
  const root = (node as Element).shadowRoot;
  if (root) text += shownText(root);
  for (const child of node.childNodes) text += shownText(child);
  return text;
}

/** The chat's Continue button, inside its shadow roots. */
function continueButton(node: Node): HTMLElement | null {
  if (
    node instanceof HTMLElement &&
    node.localName === 'civitai-button' &&
    node.textContent?.trim() === 'Continue'
  )
    return node;
  const root = (node as Element).shadowRoot;
  for (const child of [...(root ? [root] : []), ...node.childNodes]) {
    const found = continueButton(child);
    if (found) return found;
  }
  return null;
}

async function mountChat() {
  const gate = createAssistantGate();
  const ran = vi.fn(async () => ({ ok: true }));
  const noop: ChatTool = {
    description: 'Does nothing.',
    inputSchema: { properties: {} },
    execute: ran,
  };
  const results: ChatToolResult[] = [];
  renderWithProviders(
    <AppAssistantChat
      tokens={tokens}
      tools={{ noop }}
      instructions={() => ''}
      mcpServers={[]}
      beforeToolCall={gate.beforeToolCall}
      onToolResult={(result) => results.push(result)}
    />
  );
  const chatEl = () => document.querySelector('civitai-chat') as ChatEl | null;
  await vi.waitFor(() => expect(chatEl()?.app).toBeDefined(), { timeout: 10_000 });
  return { el: chatEl()!, ran, results };
}

let restore = () => undefined as void;
afterEach(() => restore());

describe('the per-reply tool-call limit, in the real chat', () => {
  test('ends the reply at the limit: the next call does not run and no further model request goes out', async () => {
    const model = stubModel((n) =>
      n === 1 ? callNoop(APP_ASSISTANT_TURN_TOOL_CALL_LIMIT + 1) : sayDone()
    );
    restore = model.restore;
    const { el, ran, results } = await mountChat();

    await el.send('Build it.');
    // Ended either way: by the page, or by the model answering in words after a further request.
    await vi.waitFor(() => expect(shownText(el)).toMatch(/Press Continue|Done\./), {
      timeout: 10_000,
    });
    expect(model.replyRequests).toEqual([1]);
    expect(shownText(el)).toContain(LIMIT_MESSAGE);
    expect(ran).toHaveBeenCalledTimes(APP_ASSISTANT_TURN_TOOL_CALL_LIMIT);
    expect(results.filter((result) => result.stopped)).toHaveLength(1);
  });

  test('Continue starts a new reply whose calls are counted afresh', async () => {
    const limit = APP_ASSISTANT_TURN_TOOL_CALL_LIMIT;
    const model = stubModel((n) =>
      n === 1 ? callNoop(limit + 1) : n === 2 ? callNoop(limit) : sayDone()
    );
    restore = model.restore;
    const { el, ran, results } = await mountChat();

    await el.send('Build it.');
    await vi.waitFor(() => expect(continueButton(el)).not.toBeNull(), { timeout: 10_000 });
    continueButton(el)!.click();
    await vi.waitFor(() => expect(model.replyRequests).toEqual([1, 2, 3]), { timeout: 10_000 });

    // All of the second reply's calls ran: its count did not carry the first reply's.
    expect(ran).toHaveBeenCalledTimes(2 * limit);
    expect(results.filter((result) => result.stopped)).toHaveLength(1);
  });

  test('under the limit, a reply runs every call and asks the model again', async () => {
    const model = stubModel((n) =>
      n === 1 ? callNoop(APP_ASSISTANT_TURN_TOOL_CALL_LIMIT) : sayDone()
    );
    restore = model.restore;
    const { el, ran, results } = await mountChat();

    await el.send('Build it.');
    await vi.waitFor(() => expect(model.replyRequests).toEqual([1, 2]), { timeout: 10_000 });

    expect(ran).toHaveBeenCalledTimes(APP_ASSISTANT_TURN_TOOL_CALL_LIMIT);
    expect(results.filter((result) => result.stopped)).toHaveLength(0);
    expect(shownText(el)).not.toContain(LIMIT_MESSAGE);
  });
});

describe('the model App Assistant asks for', () => {
  test('with no model chosen, every request, the title included, asks for GPT-6 Luna', async () => {
    const model = stubModel(() => sayDone());
    restore = model.restore;
    const { el } = await mountChat();

    await el.send('Build it.');
    await vi.waitFor(() => expect(model.replyRequests).toEqual([1]), { timeout: 10_000 });
    await vi.waitFor(() => expect(model.models.length).toBeGreaterThanOrEqual(2), {
      timeout: 10_000,
    });

    expect(new Set(model.models)).toEqual(new Set(['openai/gpt-6-luna']));
  });
});
