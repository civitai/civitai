import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useAssistantPanelStore } from '~/store/assistant-panel.store';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * 🔴 THIS FILE EXISTS BECAUSE THE STORE HAS A WRITER AND NEEDED A PROVEN READER.
 *
 * `AssistantButton`'s open state moved out of local `useState` into
 * `assistant-panel.store` so the support menu could open the chat. `SupportMenu`'s
 * tests assert the menu item WRITES the store — but until this file, nothing asserted
 * anything READ it. Reverting this component to local `useState` would have left the
 * whole branch green while the menu item became an inert button in production.
 *
 * `AssistantChat` is replaced by a marker: the real one renders an iframe from
 * env-configured origins that the test browser does not serve, and what is under test
 * is the wiring, not the chat.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    assistant: { value: null as { personality: string; uuid: string } | null },
  },
}));

vi.mock('~/components/Assistant/useAssistantAvailable', () => ({
  useAssistantAvailable: () => mocks.assistant.value,
}));

// `IsClient` reads a context the app shell provides and this harness does not; it
// gates on hydration, which is not what is under test here.
vi.mock('~/components/IsClient/IsClient', () => ({
  IsClient: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('~/components/Assistant/AssistantChat', () => ({
  AssistantChat: () => <div data-testid="assistant-chat">chat</div>,
  getAssistantUUID: () => 'uuid-1',
}));

const { AssistantButton } = await import('~/components/Assistant/AssistantButton');

const chat = () => page.getByTestId('assistant-chat');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assistant.value = { personality: 'civbot', uuid: 'uuid-1' };
  useAssistantPanelStore.setState({ opened: false });
});

describe('the chat follows the shared store, not private state', () => {
  test('🔴 opening the store from elsewhere shows the chat', async () => {
    renderWithProviders(<AssistantButton />);
    // The negative half, and the reason this test can fail: closed is the state the
    // component starts in, so an assertion on the open state alone would pass against
    // a component that always renders the chat.
    expect(chat().elements()).toHaveLength(0);

    // Exactly what the support menu's "Get help fast" item does.
    useAssistantPanelStore.setState({ opened: true });

    await expect.element(chat()).toBeInTheDocument();
  });

  /**
   * The launcher's own click is NOT asserted here, and the reason is worth writing
   * down rather than leaving as a gap: `AssistantButton` renders Mantine's `Button`
   * with `component="span"`, so it exposes no `button` role and
   * `getByRole('button')` finds nothing — it is not reachable by assistive
   * technology either. That is how it has always been (unchanged by this branch), so
   * fixing it is not this PR's, and reaching it through a Mantine class name would
   * be a test about a stylesheet. The contract that changed is the one above.
   */
});

describe('when there is no chat to show', () => {
  test('the chat stays hidden even with the store already open', async () => {
    mocks.assistant.value = null;
    // The store survives unmounts, so a stale `opened: true` from a previous session
    // must not be enough on its own — availability is the gate, not the flag.
    useAssistantPanelStore.setState({ opened: true });
    renderWithProviders(<AssistantButton />);

    expect(chat().elements()).toHaveLength(0);
  });
});
