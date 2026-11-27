import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, type TRPCLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ChatList } from '~/components/Chat/ChatList';
import { ChatListV1 } from '~/components/Chat/ChatListV1';
import { FixedSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { SignalProvider } from '~/components/Signals/SignalsProvider';
import { BrowserSettingsProvider } from '~/providers/BrowserSettingsProvider';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';
import type { AppRouter } from '~/server/routers';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * "Mark all read" on the chat list. Real list components, real `~/utils/trpc` hooks and cache;
 * only the network is replaced, by a link that answers the chat procedures.
 *
 * The tester's case: the cached unread count is ahead of the server (read in another tab, or a
 * signal over-counted), so the server's mark-all changes no membership and returns []. The
 * control is the ordinary case, where the mutation returns the chat it changed.
 */

const ME = 1;
const CHAT_ID = 10;

const member = (userId: number, over: object = {}) => ({
  userId,
  status: 'Joined',
  filteredAt: null,
  pinnedAt: null,
  isOwner: false,
  user: { id: userId, username: `user${userId}`, image: null, isModerator: false },
  ...over,
});

const CHAT = {
  id: CHAT_ID,
  name: 'Chat with Sam',
  createdAt: '2026-11-01T00:00:00Z',
  messages: [],
  chatMembers: [member(ME), member(2)],
};

const io = {
  /** What the server counts as unread right now. */
  unread: [] as { chatId: number; cnt: number }[],
  /** What the server's mark-all reports having changed. */
  changed: [] as unknown[],
  marks: 0,
};

const link: TRPCLink<AppRouter> =
  () =>
  ({ op }) =>
    observable((observer) => {
      const answer = (): unknown => {
        switch (op.path) {
          case 'chat.getAllByUser':
            return [CHAT];
          case 'chat.getUnreadCount':
            return io.unread;
          case 'chat.getUserSettings':
            return { muteSounds: false, replaceBadWords: false };
          case 'chat.markAllAsRead': {
            io.marks++;
            const changed = io.changed;
            io.unread = [];
            return changed;
          }
          default:
            return undefined;
        }
      };
      const data = answer();
      // An unscripted procedure never answers rather than resolving empty.
      if (data === undefined) return;
      observer.next({ result: { type: 'data', data } });
      observer.complete();
    });

const { Provider: TRPCProvider } = createTRPCReact<AppRouter>();

function Network({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() => createTRPCClient<AppRouter>({ links: [link] }));
  return (
    <TRPCProvider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TRPCProvider>
  );
}

// The header ChatButton keeps getUnreadCount subscribed whenever the panel is open.
function HeaderBadge() {
  trpc.chat.getUnreadCount.useQuery();
  return null;
}

beforeEach(() => {
  io.unread = [];
  io.changed = [];
  io.marks = 0;
});

// V1 keeps the action in a tools menu; the redesign has a header button.
const variants = [
  {
    name: 'ChatList',
    List: ChatList,
    label: 'Mark all read',
    role: 'button' as const,
    menu: false,
  },
  {
    name: 'ChatListV1',
    List: ChatListV1,
    label: 'Mark all as read',
    role: 'menuitem' as const,
    menu: true,
  },
];

describe.each(variants)('$name mark all read', ({ List, label, role, menu }) => {
  async function openMenu() {
    if (menu) await userEvent.click(page.getByRole('button').first());
  }

  async function markAllReadFrom(count: number) {
    renderWithProviders(
      <Network>
        <FeatureFlagsProvider flags={{} as FeatureAccess}>
          <FixedSessionProvider user={{ id: ME, username: 'me' }}>
            <BrowserSettingsProvider>
              <SignalProvider>
                <ContainerProvider containerName="chat">
                  <HeaderBadge />
                  <List />
                </ContainerProvider>
              </SignalProvider>
            </BrowserSettingsProvider>
          </FixedSessionProvider>
        </FeatureFlagsProvider>
      </Network>
    );
    await openMenu();
    await expect.element(page.getByRole(role, { name: `${label} (${count})` })).toBeVisible();
    await userEvent.click(page.getByRole(role, { name: `${label} (${count})` }));
    await expect.poll(() => io.marks).toBe(1);
    await openMenu();
    await expect.element(page.getByRole(role, { name: label, exact: true })).toBeVisible();
    expect(io.marks).toBe(1);
  }

  test('clears a count the server no longer has', async () => {
    io.unread = [{ chatId: CHAT_ID, cnt: 5 }];
    // The server has nothing to change for it (read in another tab), so mark-all returns [].
    await markAllReadFrom(5);
  });

  test('control: a count the server still has is cleared too', async () => {
    io.unread = [{ chatId: CHAT_ID, cnt: 2 }];
    io.changed = [{ chatId: CHAT_ID, lastViewedMessageId: 99 }];
    await markAllReadFrom(2);
  });
});
