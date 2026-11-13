// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * On a phone the menu sheet and the chat window are both full-screen, so opening the menu closes
 * the chat. On a desktop they sit side by side.
 */
const mocks = vi.hoisted(() => ({ isMobile: true }));

vi.mock('~/components/AppLayout/AppHeader/UserMenu', () => ({
  UserMenuTrigger: () => null,
}));
vi.mock('~/components/Notifications/notifications.utils', () => ({
  useQueryNotificationsCount: () => ({}),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => mocks.isMobile }));
vi.mock('./useUserMenuPins', () => ({
  useUserMenuPins: () => ({ mutedBadges: [], flush: () => undefined }),
}));
// Each shell is a button that asks to open and one that asks to close.
vi.mock('./UserMenuMobile', () => ({ UserMenuMobile: shell('mobile') }));
vi.mock('./UserMenuDesktop', () => ({ UserMenuDesktop: shell('desktop') }));

function shell(name: string) {
  return function Shell({ setOpen }: { setOpen: (open: boolean) => void }) {
    return createElement(
      'div',
      null,
      createElement('button', { 'data-testid': `${name}-open`, onClick: () => setOpen(true) }),
      createElement('button', { 'data-testid': `${name}-close`, onClick: () => setOpen(false) })
    );
  };
}

const { default: UserMenuV2 } = await import('./UserMenuV2');
const { useChatStore } = await import('~/components/Chat/ChatProvider');

let container: HTMLDivElement;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    createRoot(container).render(createElement(UserMenuV2));
  });
}

async function press(testId: string) {
  await act(async () => {
    container
      .querySelector(`[data-testid="${testId}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.isMobile = true;
  useChatStore.setState({ open: true });
});

afterEach(() => {
  container?.remove();
  useChatStore.setState({ open: false });
});

describe('opening the account menu while the chat window is open', () => {
  it('closes the chat on a phone', async () => {
    await mount();
    expect(useChatStore.getState().open).toBe(true);
    await press('mobile-open');
    expect(useChatStore.getState().open).toBe(false);
  });

  it('leaves the chat open on a desktop', async () => {
    mocks.isMobile = false;
    await mount();
    await press('desktop-open');
    expect(useChatStore.getState().open).toBe(true);
  });

  it('does not touch the chat when the menu closes', async () => {
    await mount();
    await press('mobile-close');
    expect(useChatStore.getState().open).toBe(true);
  });
});
