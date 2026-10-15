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
    customElements.define('civitai-chat', class extends HTMLElement {});
  return {};
});

const { AppAssistantChat } = await import('./AppAssistantChat');

const tokens = (): AssistantTokenProvider => ({
  getToken: vi.fn(async () => 'chat-token'),
  enable: vi.fn(async () => 'chat-token'),
});

type ChatEl = HTMLElement & {
  app?: unknown;
  mcp?: unknown;
  systemPrompt?: (defaults: string) => string;
  holdReason?: string;
  beforeToolCall?: unknown;
};

const chatEl = () => document.querySelector('civitai-chat') as ChatEl;

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
    renderWithProviders(
      <AppAssistantChat tokens={tokens()} tools={{}} instructions={() => ''} mcpServers={[]} />
    );
    await vi.waitFor(() => expect(chatEl().app).toBeDefined());
    expect(m.configureChat).toHaveBeenCalledWith({ maxSteps: 1000, contextBudgetTokens: 64000 });
    // The generation tools (and the panels, which run through run_step) are never offered.
    expect(chatEl().mcp).toEqual({
      orchestration: { exclude: ['run_step', 'run_workflow', 'transcribe_audio'] },
    });
    const prompt = chatEl().systemPrompt!('BUILT-IN');
    expect(prompt.startsWith('BUILT-IN\n\nApp Assistant rules')).toBe(true);
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
    expect(onToolResult).toHaveBeenCalledWith(detail);
  });
});
