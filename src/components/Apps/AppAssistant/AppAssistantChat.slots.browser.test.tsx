import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ReactNode } from 'react';
import type { AssistantTokenProvider } from '~/components/Apps/AppAssistant/assistantToken';
import type * as ConfigMod from '~/components/Apps/AppAssistant/assistantChatConfig';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// The REAL chat element (no mock of `@civitai/components-chat`): what AppAssistantChat hands it as
// `composerTop` / `threadEnd` must land in the element's own `composer-top` / `thread-end` slots and
// show where they say. Only the SDK client and the network are stubbed.
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

let restore = () => undefined as void;
afterEach(() => restore());

/** Every model request answers in words; anything else the chat asks for is not here. */
function stubModel() {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith('/v1/chat/completions')) return new Response('{}', { status: 404 });
    return sse([chunk({ role: 'assistant', content: 'Here is your app.' }), chunk({}, 'stop')]);
  });
  restore = () => vi.stubGlobal('fetch', realFetch);
}

type ChatEl = HTMLElement & { app?: unknown; send(text: string): Promise<void> };
const chatEl = () => document.querySelector('civitai-chat') as ChatEl | null;
const slot = (name: string) =>
  chatEl()!.shadowRoot!.querySelector<HTMLSlotElement>(`slot[name="${name}"]`);
const assigned = (name: string) =>
  (slot(name)?.assignedElements({ flatten: true }) ?? []).map((el) => el.textContent);

async function mount(props: { composerTop?: ReactNode; threadEnd?: ReactNode }) {
  await page.viewport(1280, 900);
  stubModel();
  renderWithProviders(
    <div style={{ width: 900, height: 700 }}>
      <AppAssistantChat
        tokens={tokens}
        tools={{}}
        instructions={() => ''}
        mcpServers={[]}
        {...props}
      />
    </div>
  );
  await vi.waitFor(() => expect(chatEl()?.app).toBeDefined(), { timeout: 15_000 });
  await vi.waitFor(
    () => expect(chatEl()!.shadowRoot!.querySelector('civitai-chat-composer')).not.toBeNull(),
    { timeout: 15_000 }
  );
}

describe('AppAssistantChat page content in the real chat’s slots', () => {
  test('composerTop shows just above the message box, and threadEnd after the last message', async () => {
    await mount({
      composerTop: <p style={{ margin: 0 }}>my-app is paused.</p>,
      threadEnd: <p style={{ margin: 0 }}>Free up a slot</p>,
    });
    await vi.waitFor(() => {
      expect(assigned('composer-top')).toEqual(['my-app is paused.']);
      expect(assigned('thread-end')).toEqual(['Free up a slot']);
    });
    const root = chatEl()!.shadowRoot!;
    const top = chatEl()!.querySelector('[slot="composer-top"]')!.getBoundingClientRect();
    const composer = root.querySelector('civitai-chat-composer')!.getBoundingClientRect();
    expect(top.height).toBeGreaterThan(0);
    expect(top.bottom).toBeLessThanOrEqual(composer.top + 0.5);

    // After a reply, thread-end sits after the last message, inside the thread.
    await chatEl()!.send('Build me a tip calculator');
    await vi.waitFor(
      () => expect(root.querySelectorAll('civitai-chat-turn').length).toBeGreaterThan(0),
      { timeout: 10_000 }
    );
    await vi.waitFor(() => expect(assigned('thread-end')).toEqual(['Free up a slot']));
    const thread = root.querySelector('civitai-chat-thread')!;
    expect(thread.contains(slot('thread-end'))).toBe(true);
    const lastTurn = [...root.querySelectorAll('civitai-chat-turn')]
      .at(-1)!
      .getBoundingClientRect();
    const end = chatEl()!.querySelector('[slot="thread-end"]')!.getBoundingClientRect();
    expect(end.height).toBeGreaterThan(0);
    expect(end.top).toBeGreaterThanOrEqual(lastTurn.bottom - 0.5);
  });

  test('NEGATIVE CONTROL: with neither given, nothing is slotted and the slots take no space', async () => {
    await mount({});
    for (const name of ['composer-top', 'thread-end']) {
      expect(slot(name), name).not.toBeNull();
      expect(assigned(name), name).toEqual([]);
      expect(slot(name)!.getBoundingClientRect().height, name).toBe(0);
    }
  });
});
