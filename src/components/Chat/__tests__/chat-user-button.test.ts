// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as ChatEnabled from '~/components/Chat/useChatEnabled';
import type * as LoginPopoverModule from '~/components/LoginPopover/LoginPopover';

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1 }),
}));

vi.mock('~/components/Chat/useChatEnabled', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatEnabled>()),
  useChatEnabled: () => true,
}));

vi.mock('~/components/LoginPopover/LoginPopover', async (importOriginal) => ({
  ...(await importOriginal<typeof LoginPopoverModule>()),
  LoginPopover: ({ children }: { children: React.ReactNode }) => children,
}));

const { ChatUserButton } = await import('~/components/Chat/ChatUserButton');
const { useChatStore } = await import('~/components/Chat/ChatProvider');
const { theme } = await import('~/providers/ThemeProvider');

const cosmetic = (id: number, type: string, name: string, equippedAt: Date | null) => ({
  cosmeticId: id,
  equippedAt,
  data: null,
  cosmetic: { id, type, name, data: {}, source: 'Purchase' },
});

async function clickChat(user: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(MantineProvider, { theme }, createElement(ChatUserButton, { user } as never))
    );
  });
  const button = container.querySelector('button');
  if (!button) throw new Error('ChatUserButton rendered no button');
  await act(async () => button.click());
  root.unmount();
  return useChatStore.getState().selectedUsers;
}

afterEach(() => {
  useChatStore.setState({ selectedUsers: [], open: false, isCreating: false });
  document.body.innerHTML = '';
});

describe('ChatUserButton hands New Chat only what the user is wearing', () => {
  // A profile page's user carries every cosmetic the user owns. New Chat renders the
  // selected user through Username, which shows the first badge and nameplate in the
  // list, so an owned-but-unequipped one listed first stood in for the worn one.
  it('drops owned cosmetics that are not equipped', async () => {
    const [selected] = await clickChat({
      id: 2,
      username: 'someone',
      cosmetics: [
        cosmetic(94, 'Badge', 'Owned badge', null),
        cosmetic(184, 'NamePlate', 'Owned nameplate', null),
        cosmetic(2874, 'NamePlate', 'Worn nameplate', new Date('2026-10-07')),
        cosmetic(3433, 'Badge', 'Worn badge', new Date('2026-10-16')),
      ],
    });

    expect(selected.cosmetics?.map((c) => c.cosmetic.name)).toEqual([
      'Worn nameplate',
      'Worn badge',
    ]);
  });

  // CreatorCard and PostDetail pass users whose list is already equipped-only and
  // carries no equippedAt at all; those must reach the chat untouched.
  it('keeps every cosmetic of a list that has no equippedAt field', async () => {
    const equippedOnly = [
      { data: null, cosmetic: { id: 3433, type: 'Badge', name: 'Worn badge', data: {} } },
      { data: null, cosmetic: { id: 2874, type: 'NamePlate', name: 'Worn nameplate', data: {} } },
    ];
    const [selected] = await clickChat({ id: 2, username: 'someone', cosmetics: equippedOnly });

    expect(selected.cosmetics?.map((c) => c.cosmetic.name)).toEqual([
      'Worn badge',
      'Worn nameplate',
    ]);
  });
});
