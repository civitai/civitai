import { describe, expect, test, vi } from 'vitest';
import type { ChatRemoteRunner } from '@civitai/components-chat/civitai-chat';
import type { AssistantTokenProvider } from '~/components/Apps/AppAssistant/assistantToken';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

vi.mock('@civitai/sdk', () => ({ initialize: vi.fn(async () => ({})) }));
vi.mock('@civitai/components-chat/civitai-chat', () => ({ configureChat: vi.fn() }));
vi.mock('@civitai/components-chat/civitai-chat/define', () => {
  if (!customElements.get('civitai-chat'))
    customElements.define(
      'civitai-chat',
      class extends HTMLElement {
        #app: unknown;
        /** Which runner was set when `app` (which starts the chat on it) was. */
        atStart: { runner: unknown; remoteRunner: unknown; hasRunner: boolean } | null = null;
        get app() {
          return this.#app;
        }
        set app(value: unknown) {
          const self = this as unknown as { runner?: unknown; remoteRunner?: unknown };
          this.atStart = {
            runner: self.runner,
            remoteRunner: self.remoteRunner,
            hasRunner: Object.prototype.hasOwnProperty.call(this, 'runner'),
          };
          this.#app = value;
        }
      }
    );
  return {};
});

const { AppAssistantChat } = await import('./AppAssistantChat');

const tokens = (): AssistantTokenProvider => ({
  getToken: vi.fn(async () => 'chat-token'),
  enable: vi.fn(async () => 'chat-token'),
});

type ChatEl = HTMLElement & {
  app?: unknown;
  runner?: unknown;
  remoteRunner?: unknown;
  atStart: { runner: unknown; remoteRunner: unknown; hasRunner: boolean } | null;
};
const chatEl = () => document.querySelector('civitai-chat') as unknown as ChatEl;

describe('AppAssistantChat and the server runner', () => {
  test('with the flag off, the chat runs replies in the browser: no runner is ever set', async () => {
    renderWithProviders(
      <AppAssistantChat tokens={tokens()} tools={{}} instructions={() => ''} mcpServers={[]} />
    );
    await vi.waitFor(() => expect(chatEl().app).toBeDefined());
    expect(chatEl().atStart).toEqual({
      runner: undefined,
      remoteRunner: undefined,
      hasRunner: false,
    });
    expect(chatEl().runner).toBeUndefined();
    expect(chatEl().remoteRunner).toBeUndefined();
  });

  test('with the flag on, the chat starts on the remote runner, set before app', async () => {
    const remoteRunner: ChatRemoteRunner = { url: '/api/assistant-runner' };
    renderWithProviders(
      <AppAssistantChat
        tokens={tokens()}
        tools={{}}
        instructions={() => ''}
        mcpServers={[]}
        remoteRunner={remoteRunner}
      />
    );
    await vi.waitFor(() => expect(chatEl().app).toBeDefined());
    expect(chatEl().atStart).toEqual({ runner: 'remote', remoteRunner, hasRunner: true });
  });
});
