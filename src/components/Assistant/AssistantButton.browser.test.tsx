import type { ButtonProps } from '@mantine/core';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useAssistantPanelStore } from '~/store/assistant-panel.store';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * 🔴 THIS FILE EXISTS BECAUSE THE STORE HAS A WRITER AND NEEDED A PROVEN READER.
 *
 * `AssistantButton`'s open state moved out of local `useState` into
 * `assistant-panel.store` so the support menu could open the chat. `SupportMenu`'s
 * tests assert the menu item WRITES the store — without this file nothing asserted
 * anything READ it, and reverting this component to local `useState` would have left
 * the whole branch green while the menu item became an inert button in production.
 *
 * 🔴 EVERY NEGATIVE READ HERE IS PRECEDED BY AN AWAITED MARKER, AND MUST STAY THAT
 * WAY. `renderWithProviders` does not commit synchronously: a bare
 * `expect(chat().elements()).toHaveLength(0)` straight after it passes because
 * nothing has rendered YET, not because the chat is absent. Both negatives in the
 * first version of this file were vacuous for exactly that reason — a mutation
 * deleting the availability gate entirely still left it at 2 passed. The marker is a
 * sibling that always renders, so awaiting it proves the commit happened before any
 * absence is read.
 *
 * `AssistantChat` is replaced by a marker element: the real one renders an iframe
 * from env-configured origins the test browser does not serve. `IsClient` is replaced
 * because it reads a context the harness has no provider for.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    assistant: { value: null as { personality: string; uuid: string } | null },
  },
}));

vi.mock('~/components/Assistant/useAssistantAvailable', () => ({
  useAssistantAvailable: () => mocks.assistant.value,
}));

vi.mock('~/components/IsClient/IsClient', () => ({
  IsClient: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('~/components/Assistant/AssistantChat', () => ({
  AssistantChat: () => <div data-testid="assistant-chat">chat</div>,
}));

const { AssistantButton } = await import('~/components/Assistant/AssistantButton');

const chat = () => page.getByTestId('assistant-chat');
const launcher = () => page.getByTestId('assistant-launcher');

/** Renders a sibling that always renders, and waits for it — see the file header. */
const renderAndSettle = async () => {
  renderWithProviders(
    <>
      <span data-testid="committed">committed</span>
      <AssistantButton {...({ 'data-testid': 'assistant-launcher' } as ButtonProps)} />
    </>
  );
  await expect.element(page.getByTestId('committed')).toBeInTheDocument();
};

beforeEach(() => {
  mocks.assistant.value = { personality: 'civbot', uuid: 'uuid-1' };
  useAssistantPanelStore.setState({ opened: false });
});

describe('the chat follows the shared store, not private state', () => {
  test('🔴 opening the store from elsewhere shows the chat', async () => {
    await renderAndSettle();
    expect(chat().elements()).toHaveLength(0);

    // Exactly what the support menu's "Get help fast" item does.
    useAssistantPanelStore.setState({ opened: true });

    await expect.element(chat()).toBeInTheDocument();
  });

  /**
   * The launcher's own click, reached through the `data-testid` the component already
   * spreads onto its Button rather than through `getByRole('button')`: it renders
   * Mantine's `Button` with `component="span"`, so no button role exists — which also
   * means assistive technology cannot reach it. That is how it renders today;
   * whether the span is load-bearing is NOT established here, and changing it belongs
   * to whoever owns that component. Reaching the element through a Mantine class name
   * would have made this a test about a stylesheet.
   */
  test('the launcher toggles the store both ways', async () => {
    await renderAndSettle();

    await userEvent.click(launcher());
    await expect.element(chat()).toBeInTheDocument();
    expect(useAssistantPanelStore.getState().opened).toBe(true);

    await userEvent.click(launcher());
    expect(useAssistantPanelStore.getState().opened).toBe(false);
  });
});

describe('when there is no chat to show', () => {
  test('the chat stays hidden even with the store already open', async () => {
    mocks.assistant.value = null;
    // The store survives unmounts, so a stale `opened: true` must not be enough on its
    // own — availability is the gate, not the flag.
    useAssistantPanelStore.setState({ opened: true });
    await renderAndSettle();

    expect(chat().elements()).toHaveLength(0);
  });
});
