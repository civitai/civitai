import { describe, expect, test, vi } from 'vitest';
import type { AssistantTokenProvider } from '~/components/Apps/AppAssistant/assistantToken';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

type InitOptions = {
  token: () => Promise<string>;
  requestGrants: (scopes: readonly string[]) => boolean | Promise<boolean>;
};

const m = vi.hoisted(() => ({ options: null as null | InitOptions }));

vi.mock('@civitai/sdk', () => ({
  initialize: vi.fn(async (options: InitOptions) => {
    m.options = options;
    return {};
  }),
}));
vi.mock('@civitai/components-chat/civitai-chat/define', () => {
  if (!customElements.get('civitai-chat'))
    customElements.define('civitai-chat', class extends HTMLElement {});
  return {};
});

const { AppAssistantChat } = await import('./AppAssistantChat');

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
});
