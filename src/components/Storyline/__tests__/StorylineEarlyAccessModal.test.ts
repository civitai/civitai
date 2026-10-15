// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import type { ReactElement } from 'react';
import { act, cloneElement, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StorylineEarlyAccessModal } from '~/components/Storyline/StorylineEarlyAccessModal';
import type * as NotificationsModule from '~/utils/notifications';

const mocks = vi.hoisted(() => ({
  join: vi.fn<(input: { storylineId?: number }) => Promise<unknown>>(),
  showError: vi.fn(),
  user: { id: 1 } as { id: number } | null,
  requireLogin: vi.fn(),
}));

vi.mock('~/components/Storyline/storyline.queries', () => ({
  useStorylineEarlyAccess: () => ({ joined: false, join: mocks.join, isJoining: false }),
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: vi.fn() }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
// Like the real one: the wrapped button sends the reader to sign in, with a reason.
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children, reason }: { children: ReactElement; reason: string }) =>
    cloneElement(children as ReactElement<{ onClick?: () => void }>, {
      onClick: () => mocks.requireLogin(reason),
    }),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: mocks.showError,
}));

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        { forceColorScheme: 'light' },
        createElement(StorylineEarlyAccessModal, { chapterId: 4, storylineId: 9 })
      )
    );
  });
}

async function clickJoin() {
  const button = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Get early access')
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

describe('StorylineEarlyAccessModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.join.mockReset();
    mocks.showError.mockClear();
    mocks.user = { id: 1 };
    mocks.requireLogin.mockClear();
  });

  it('joins for this storyline and says so', async () => {
    mocks.join.mockResolvedValue(undefined);
    render();
    await clickJoin();
    expect(mocks.join).toHaveBeenCalledWith({ storylineId: 9 });
    expect(document.body.textContent).toContain('You are on the list.');
    expect(mocks.showError).not.toHaveBeenCalled();
  });

  it('says the join failed instead of claiming the reader is on the list', async () => {
    mocks.join.mockRejectedValue(new Error('nope'));
    render();
    await clickJoin();
    expect(document.body.textContent).not.toContain('You are on the list.');
    expect(mocks.showError).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Could not join early access' })
    );
  });

  it('asks a signed-out reader to sign in instead of offering to join', () => {
    mocks.user = null;
    render();
    const buttons = [...document.body.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).not.toContain('Get early access');
    const signIn = buttons.find((b) => b.textContent === 'Sign in for early access');
    act(() => signIn?.click());
    expect(mocks.requireLogin.mock.calls).toEqual([['storyline-early-access']]);
    expect(mocks.join).not.toHaveBeenCalled();
  });
});
