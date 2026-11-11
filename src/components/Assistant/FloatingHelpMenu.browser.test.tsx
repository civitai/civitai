import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { useAssistantPanelStore } from '~/store/assistant-panel.store';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * Every negative read is preceded by an awaited marker: `renderWithProviders` does not commit
 * synchronously, so an absence read straight after it passes because nothing has rendered yet.
 *
 * `AssistantChat` is a marker element (the real one renders an iframe from env-configured
 * origins). `IsClient` reads a context the harness has no provider for.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    trigger: vi.fn(),
    currentUser: { value: null as { id: number } | null },
    areaEnabled: { value: true },
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
vi.mock('~/components/Feedback/FeedbackDrawer', () => ({
  default: () => <div data-testid="feedback-drawer">drawer</div>,
}));
vi.mock('~/components/Dialog/dialogStore', () => ({
  dialogStore: { trigger: mocks.trigger, toggle: vi.fn(), closeById: vi.fn() },
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser.value,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: makeTrpcProxy({
      // A disabled query resolves to `undefined`, as React Query's does.
      'feedback.getArea': {
        useQuery: (_input: unknown, options?: { enabled?: boolean }) =>
          options?.enabled ? { data: { enabled: mocks.areaEnabled.value } } : { data: undefined },
      },
    }),
  };
});

const { FloatingHelpMenu } = await import('~/components/Assistant/FloatingHelpMenu');

const chat = () => page.getByTestId('assistant-chat');
const trigger = () => page.getByRole('button', { name: 'Help and feedback' });
const civbotItem = () => page.getByRole('menuitem', { name: 'Ask CivBot' });
const reportItem = () => page.getByRole('menuitem', { name: 'Report a problem' });

const renderAndSettle = async () => {
  renderWithProviders(
    <>
      <span data-testid="committed">committed</span>
      <FloatingHelpMenu />
    </>
  );
  await expect.element(page.getByTestId('committed')).toBeInTheDocument();
};

const openMenu = async () => {
  await renderAndSettle();
  await userEvent.click(trigger());
  await expect.element(reportItem()).toBeInTheDocument();
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.value = { id: 1 };
  mocks.areaEnabled.value = true;
  mocks.assistant.value = { personality: 'civbot', uuid: 'uuid-1' };
  useAssistantPanelStore.setState({ opened: false });
});

describe('the menu', () => {
  test('lists CivBot and Report a problem', async () => {
    await openMenu();
    await expect.element(civbotItem()).toBeInTheDocument();
  });

  test('Ask CivBot opens the chat, and the button then closes it', async () => {
    await openMenu();
    await userEvent.click(civbotItem());
    await expect.element(chat()).toBeInTheDocument();

    await userEvent.click(page.getByRole('button', { name: 'Close CivBot' }));
    expect(useAssistantPanelStore.getState().opened).toBe(false);
  });

  test('Escape closes the menu and returns focus to the button', async () => {
    await openMenu();
    await userEvent.keyboard('{Escape}');
    await expect.element(reportItem()).not.toBeInTheDocument();
    await expect.element(trigger()).toHaveFocus();
  });

  test('Report a problem opens the bug report when the area is collecting', async () => {
    await openMenu();
    await userEvent.click(reportItem());
    expect(mocks.trigger).toHaveBeenCalledTimes(1);
    // The dialog it opens is the bug-report drawer (stubbed to a marker below).
    const { component: Dialog } = mocks.trigger.mock.calls[0][0] as {
      component: React.ComponentType;
    };
    renderWithProviders(<Dialog />);
    await expect.element(page.getByTestId('feedback-drawer')).toBeInTheDocument();
  });

  test('Report a problem is the ticket link when the area is off', async () => {
    mocks.areaEnabled.value = false;
    await openMenu();
    await expect.element(reportItem()).toHaveAttribute('href', '/bugs');
    await expect.element(reportItem()).toHaveAttribute('target', '_blank');
  });
});

describe('the chat follows the shared store', () => {
  test('opening the store from elsewhere shows the chat', async () => {
    await renderAndSettle();
    expect(chat().elements()).toHaveLength(0);

    useAssistantPanelStore.setState({ opened: true });

    await expect.element(chat()).toBeInTheDocument();
  });
});

describe('without CivBot', () => {
  test('the menu still offers Report a problem, and no chat shows even with the store open', async () => {
    mocks.assistant.value = null;
    useAssistantPanelStore.setState({ opened: true });
    await renderAndSettle();
    expect(chat().elements()).toHaveLength(0);

    await userEvent.click(trigger());
    await expect.element(reportItem()).toBeInTheDocument();
    expect(civbotItem().elements()).toHaveLength(0);
  });
});

test('signed out, there is no button', async () => {
  mocks.currentUser.value = null;
  await renderAndSettle();
  expect(trigger().elements()).toHaveLength(0);
});
