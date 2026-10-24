import { describe, expect, test, vi } from 'vitest';
import type { AssistantTokenProvider } from '~/components/Apps/AppAssistant/assistantToken';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

type InitOptions = {
  token: () => Promise<string>;
  requestGrants: (scopes: readonly string[]) => boolean | Promise<boolean>;
};

const m = vi.hoisted(() => ({ options: null as null | InitOptions, configureChat: vi.fn() }));

vi.mock('@civitai/sdk', () => ({
  initialize: vi.fn(async (options: InitOptions) => {
    m.options = options;
    return {};
  }),
}));
vi.mock('@civitai/components-chat/civitai-chat', () => ({ configureChat: m.configureChat }));
vi.mock('@civitai/components-chat/civitai-chat/define', () => {
  if (!customElements.get('civitai-chat'))
    customElements.define(
      'civitai-chat',
      class extends HTMLElement {
        #app: unknown;
        #subagents: unknown;
        /** What was already set when `app` (which starts the chat) was. */
        atStart: unknown = null;
        /** Every value assigned to `subagents`, in order. */
        subagentsAssigned: unknown[] = [];
        get subagents() {
          return this.#subagents;
        }
        set subagents(value: unknown) {
          this.subagentsAssigned.push(value);
          this.#subagents = value;
        }
        get app() {
          return this.#app;
        }
        set app(value: unknown) {
          const self = this as unknown as {
            mcp?: unknown;
            systemPrompt?: unknown;
            examples?: unknown;
            placeholder?: unknown;
          };
          this.atStart = {
            mcp: self.mcp,
            systemPrompt: self.systemPrompt,
            examples: self.examples,
            placeholder: self.placeholder,
            subagents: this.#subagents,
            configured: m.configureChat.mock.calls.length,
          };
          this.#app = value;
        }
      }
    );
  return {};
});

const { AppAssistantChat } = await import('./AppAssistantChat');
const { APP_ASSISTANT_RULES, buildAssistantSystemPrompt, buildAssistantSystemPromptWithSubagents } =
  await import('./assistantInstructions');
const { APP_ASSISTANT_SUBAGENTS } = await import('./assistantSubagents');

const tokens = (): AssistantTokenProvider => ({
  getToken: vi.fn(async () => 'chat-token'),
  enable: vi.fn(async () => 'chat-token'),
});

type ChatEl = HTMLElement & {
  app?: unknown;
  atStart: {
    mcp: unknown;
    systemPrompt: unknown;
    examples: unknown;
    placeholder: unknown;
    subagents: unknown;
    configured: number;
  } | null;
  subagents?: unknown;
  subagentsAssigned: unknown[];
  mcp?: unknown;
  examples?: { title: string; prompt: string }[];
  placeholder?: string;
  systemPrompt?: (defaults: string) => string;
  holdReason?: string;
  beforeToolCall?: unknown;
};

const chatEl = () => document.querySelector('civitai-chat') as unknown as ChatEl;

describe('AppAssistantChat', () => {
  test('grants only the scopes the chat token holds', async () => {
    const tokens: AssistantTokenProvider = {
      getToken: vi.fn(async () => 'chat-token'),
      enable: vi.fn(async () => 'chat-token'),
    };
    renderWithProviders(
      <AppAssistantChat tokens={tokens} tools={{}} instructions={() => ''} mcpServers={[]} />
    );
    await vi.waitFor(() => expect(m.options).not.toBeNull());
    const { requestGrants } = m.options!;
    expect(await requestGrants(['ai:write:budgeted'])).toBe(true);
    // The chat asks for this before posting; the page's token can never carry it.
    expect(await requestGrants(['posts:write:self'])).toBe(false);
    expect(await m.options!.token()).toBe('chat-token');
  });

  test('configures the chat for App Assistant before it starts', async () => {
    m.configureChat.mockClear();
    renderWithProviders(
      <AppAssistantChat tokens={tokens()} tools={{}} instructions={() => ''} mcpServers={[]} />
    );
    await vi.waitFor(() => expect(chatEl().app).toBeDefined());
    expect(m.configureChat).toHaveBeenCalledWith({
      name: 'App Assistant',
      model: 'openai/gpt-6-luna',
      maxSteps: 1000,
      contextBudgetTokens: 64000,
    });
    expect(chatEl().mcp).toEqual({
      orchestration: {
        exclude: ['run_step', 'run_workflow', 'transcribe_audio', 'caption_media', 'web_search'],
      },
    });
    const prompt = chatEl().systemPrompt!('BUILT-IN');
    expect(prompt.startsWith('BUILT-IN\n\nApp Assistant rules')).toBe(true);
    // All in place when `app` is set, which is what starts the chat.
    expect(chatEl().atStart).toEqual({
      mcp: chatEl().mcp,
      systemPrompt: chatEl().systemPrompt,
      examples: chatEl().examples,
      placeholder: chatEl().placeholder,
      subagents: undefined,
      configured: 1,
    });
  });

  test('without subagents, never sets them, and the system prompt is the one without them', async () => {
    const props = { tokens: tokens(), tools: {}, instructions: () => '', mcpServers: [] };
    const { rerender } = await renderWithProviders(<AppAssistantChat {...props} />);
    await vi.waitFor(() => expect(chatEl().app).toBeDefined());
    await rerender(<AppAssistantChat {...props} instructions={() => 'again'} />);
    expect(chatEl().subagentsAssigned).toEqual([]);
    expect(chatEl().systemPrompt).toBe(buildAssistantSystemPrompt);
    expect(chatEl().systemPrompt!('BUILT-IN')).toBe(`BUILT-IN\n\n${APP_ASSISTANT_RULES}`);
  });

  test('with subagents, gives them and the rules for them to the chat before it starts', async () => {
    const props = { tokens: tokens(), tools: {}, instructions: () => '', mcpServers: [] };
    await renderWithProviders(<AppAssistantChat {...props} subagents={APP_ASSISTANT_SUBAGENTS} />);
    await vi.waitFor(() => expect(chatEl().app).toBeDefined());
    expect(chatEl().atStart?.subagents).toBe(APP_ASSISTANT_SUBAGENTS);
    expect(chatEl().atStart?.systemPrompt).toBe(buildAssistantSystemPromptWithSubagents);
    expect(chatEl().systemPrompt!('BUILT-IN')).toContain('dispatch_agent');
    expect(chatEl().subagentsAssigned).toEqual([APP_ASSISTANT_SUBAGENTS]);
  });

  test('offers app-building examples and hint in place of the chat’s media ones', async () => {
    const chatRef = { current: null as unknown };
    renderWithProviders(
      <AppAssistantChat
        tokens={tokens()}
        tools={{}}
        instructions={() => ''}
        mcpServers={[]}
        chatRef={chatRef as never}
      />
    );
    await vi.waitFor(() => expect(chatEl().app).toBeDefined());
    // Not the chat's own examples and hint, which are about making media with tools this page excludes.
    const examples = chatEl().examples!;
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.every((e) => e.title.trim() && e.prompt.trim())).toBe(true);
    const titles = examples.map((e) => e.title);
    for (const media of ['Make a picture', 'Make a short video', 'Write a song', 'Say it out loud'])
      expect(titles).not.toContain(media);
    expect(chatEl().placeholder?.trim()).toBeTruthy();
    expect(chatEl().placeholder).not.toMatch(/picture|video|song/i);
    expect(chatRef.current).toBe(chatEl());
  });

  test('passes the hold and the tool gate on, and reports each tool result', async () => {
    const gate = vi.fn(() => ({ allow: true as const }));
    const onToolResult = vi.fn();
    const props = {
      tokens: tokens(),
      tools: {},
      instructions: () => '',
      mcpServers: [],
      beforeToolCall: gate,
      onToolResult,
    };
    const { rerender } = await renderWithProviders(
      <AppAssistantChat {...props} holdReason="The sandbox is starting…" />
    );
    await vi.waitFor(() => expect(chatEl().holdReason).toBe('The sandbox is starting…'));
    expect(chatEl().beforeToolCall).toBe(gate);

    rerender(<AppAssistantChat {...props} />);
    await vi.waitFor(() => expect(chatEl().holdReason).toBeUndefined());

    const detail = {
      name: 'sandbox__run_command',
      input: {},
      output: 'exit_code: 0',
      isError: false,
    };
    chatEl().dispatchEvent(new CustomEvent('tool-result', { detail }));
    expect(onToolResult.mock.calls).toEqual([[detail]]);

    // A new handler replaces the old one rather than joining it.
    const next = vi.fn();
    await rerender(<AppAssistantChat {...props} onToolResult={next} />);
    chatEl().dispatchEvent(new CustomEvent('tool-result', { detail }));
    expect(next.mock.calls).toEqual([[detail]]);
    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  test('tells the page of each message before it goes, with the chat’s queue()', async () => {
    const hold = vi.fn();
    renderWithProviders(
      <AppAssistantChat
        tokens={tokens()}
        tools={{}}
        instructions={() => ''}
        mcpServers={[]}
        onBeforeSend={hold}
      />
    );
    await vi.waitFor(() => expect(chatEl().app).toBeDefined());
    const queue = () => ({ text: '', release: () => undefined, cancel: () => undefined });
    const send = (text: string) => {
      const event = new CustomEvent('before-send', {
        detail: { text, queue },
        cancelable: true,
        bubbles: true,
        composed: true,
      });
      chatEl().dispatchEvent(event);
      return event.defaultPrevented;
    };
    await vi.waitFor(() => {
      send('Add a dark mode');
      expect(hold).toHaveBeenCalled();
    });
    // The page gets the message and the chat's own queue(), and never keeps a message out itself.
    expect(hold.mock.calls.at(-1)).toEqual(['Add a dark mode', queue]);
    expect(send('Add a dark mode')).toBe(false);
  });

  test('an ask for a failed reply the page holds back is kept from the chat; any other goes on', async () => {
    const hold = vi.fn((trigger: string) => trigger === 'retry');
    renderWithProviders(
      <AppAssistantChat
        tokens={tokens()}
        tools={{}}
        instructions={() => ''}
        mcpServers={[]}
        onReplyResume={hold}
      />
    );
    await vi.waitFor(() => expect(chatEl().app).toBeDefined());
    const resume = (trigger: string) => {
      const event = new CustomEvent('reply-resume', {
        detail: { trigger },
        cancelable: true,
        bubbles: true,
        composed: true,
      });
      chatEl().dispatchEvent(event);
      return event.defaultPrevented;
    };
    await vi.waitFor(() => expect(resume('retry')).toBe(true));
    expect(resume('online')).toBe(false);
    expect(hold.mock.calls.at(-1)).toEqual(['online']);
  });

  test('tells the page which chat is open, including the one it started on', async () => {
    const onChatChange = vi.fn();
    const props = { tokens: tokens(), tools: {}, instructions: () => '', mcpServers: [] };
    const { rerender } = await renderWithProviders(<AppAssistantChat {...props} />);
    await vi.waitFor(() => expect(chatEl().app).toBeDefined());
    // Already open before the page listens.
    Object.defineProperty(chatEl(), 'chatId', { value: 'chat-1', configurable: true });
    await rerender(<AppAssistantChat {...props} onChatChange={onChatChange} />);
    await vi.waitFor(() => expect(onChatChange).toHaveBeenCalledWith('chat-1'));
    chatEl().dispatchEvent(
      new CustomEvent('chat-change', {
        detail: { chatId: 'chat-2' },
        bubbles: true,
        composed: true,
      })
    );
    expect(onChatChange.mock.calls).toEqual([['chat-1'], ['chat-2']]);
  });
});
