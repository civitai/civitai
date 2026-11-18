// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * A conversation set to Nothing stays silent and off the badge even when the
 * chat list has not loaded yet (a fresh page with the chat panel closed). The
 * hook has to learn the member's real level before it rings or counts.
 */
const ME = 7;
const CHAT = 42;

type Unread = { chatId: number; cnt: number }[];

const state = vi.hoisted(() => ({
  user: { id: 7, username: 'me' },
  handlers: {} as Record<string, (payload: unknown) => void>,
  /** what the getAllByUser cache holds right now; undefined = not loaded */
  cached: undefined as unknown[] | undefined,
  /** what the server returns when the hook fetches the list */
  server: [] as unknown[],
  fetchFails: false,
  ensureCalls: 0,
  pendingFetch: undefined as Promise<unknown> | undefined,
  invalidated: [] as string[],
  unread: [] as Unread,
  played: 0,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.user }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({ chat: true }) }));
vi.mock('use-sound', () => ({ default: () => [() => state.played++] }));
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalConnection: (message: string, cb: (payload: unknown) => void) => {
    state.handlers[message] = cb;
  },
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  // eslint-disable-next-line local-rules/no-hand-enumerated-trpc-mock -- the hooks only reach useUtils, and the stub records which caches they touch
  trpc: {
    useUtils: () => ({
      chat: {
        getAllByUser: {
          getData: () => state.cached,
          ensureData: () => {
            state.ensureCalls++;
            state.pendingFetch = Promise.resolve().then(() => {
              if (state.fetchFails) throw new Error('network');
              state.cached = state.server;
              return state.server;
            });
            return state.pendingFetch;
          },
          invalidate: () => state.invalidated.push('getAllByUser'),
          setData: () => undefined,
        },
        getInfiniteMessages: { setInfiniteData: () => undefined },
        getUnreadCount: {
          invalidate: () => state.invalidated.push('getUnreadCount'),
          setData: (_: undefined, updater: (old: Unread) => Unread) => {
            state.unread = updater(state.unread);
          },
        },
        getUserSettings: { getData: () => undefined },
      },
    }),
  },
}));

import { useChatNewMessageSignal, useChatNewRoomSignal } from '~/components/Chat/ChatSignals';
import { SignalMessages } from '~/server/common/enums';

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  state.user = { id: ME, username: 'me' };
  state.handlers = {};
  state.cached = undefined;
  state.server = [];
  state.fetchFails = false;
  state.ensureCalls = 0;
  state.pendingFetch = undefined;
  state.invalidated = [];
  state.unread = [];
  state.played = 0;
});

let rerender: () => void = () => undefined;
const mount = (hook: () => void) => {
  function Probe() {
    hook();
    return null;
  }
  root = createRoot(document.createElement('div'));
  rerender = () => act(() => root!.render(createElement(Probe)));
  rerender();
};

const members = (level: string) => [
  { userId: 99, filteredAt: null, notifyLevel: 'All' },
  { userId: ME, filteredAt: null, notifyLevel: level },
];
const chatList = (level: string) => [{ id: CHAT, chatMembers: members(level), messages: [] }];

const receive = (message: SignalMessages, payload: unknown) => {
  const handler = state.handlers[message];
  if (!handler) throw new Error(`the hook never subscribed to ${message}`);
  handler(payload);
};

const message = (id = 1000, content = 'hello') => ({
  id,
  chatId: CHAT,
  userId: 99,
  content,
  contentType: 'Markdown',
  createdAt: new Date().toISOString(),
});

/** lets the hook's await on the list fetch settle */
const settle = async () => {
  await act(async () => {
    await state.pendingFetch?.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
  });
};

const unreadFor = (chatId: number) => state.unread.find((u) => u.chatId === chatId)?.cnt ?? 0;

describe('a new message before the chat list has loaded', () => {
  it('stays silent and off the badge when the member set the chat to Nothing', async () => {
    state.server = chatList('None');
    mount(useChatNewMessageSignal);
    receive(SignalMessages.ChatNewMessage, message());
    await settle();

    expect(state.played).toBe(0);
    expect(unreadFor(CHAT)).toBe(0);
  });

  it('control: rings and counts when the member is on All', async () => {
    state.server = chatList('All');
    mount(useChatNewMessageSignal);
    receive(SignalMessages.ChatNewMessage, message());
    await settle();

    expect(state.played).toBe(1);
    expect(unreadFor(CHAT)).toBe(1);
  });

  it('on Mentions, rings only for a message that mentions the member', async () => {
    state.server = chatList('Mentions');
    mount(useChatNewMessageSignal);
    receive(SignalMessages.ChatNewMessage, message(1000, 'hello all'));
    await settle();
    expect(state.played).toBe(0);

    receive(SignalMessages.ChatNewMessage, message(1001, 'hey @me'));
    await settle();
    expect(state.played).toBe(1);
    expect(unreadFor(CHAT)).toBe(1);
  });

  it('fetches the list once for two messages back to back, and counts both', async () => {
    state.server = chatList('All');
    mount(useChatNewMessageSignal);
    receive(SignalMessages.ChatNewMessage, message(1000));
    receive(SignalMessages.ChatNewMessage, message(1001));
    await settle();

    expect(state.ensureCalls).toBe(1);
    expect(unreadFor(CHAT)).toBe(2);
    expect(state.played).toBe(2);
  });

  it('stays silent and leaves the badge to the server when the list fetch fails', async () => {
    state.fetchFails = true;
    mount(useChatNewMessageSignal);
    receive(SignalMessages.ChatNewMessage, message());
    await settle();

    expect(state.played).toBe(0);
    expect(unreadFor(CHAT)).toBe(0);
    expect(state.invalidated).toContain('getUnreadCount');
  });

  it('does nothing once unmounted mid-fetch', async () => {
    state.server = chatList('All');
    mount(useChatNewMessageSignal);
    receive(SignalMessages.ChatNewMessage, message());
    act(() => root?.unmount());
    root = undefined;
    await settle();

    expect(state.played).toBe(0);
    expect(unreadFor(CHAT)).toBe(0);
  });
  it('does nothing when another user signed in mid-fetch', async () => {
    state.server = chatList('All');
    mount(useChatNewMessageSignal);
    receive(SignalMessages.ChatNewMessage, message());
    state.user = { id: 8, username: 'other' };
    rerender();
    await settle();

    expect(state.played).toBe(0);
    expect(unreadFor(CHAT)).toBe(0);
  });

  it('stays silent when the member is missing from the chat it loaded', async () => {
    state.server = [{ id: CHAT, chatMembers: [members('All')[0]], messages: [] }];
    mount(useChatNewMessageSignal);
    receive(SignalMessages.ChatNewMessage, message());
    await settle();

    expect(state.played).toBe(0);
    expect(unreadFor(CHAT)).toBe(0);
  });
});

describe('a new message with the chat list loaded', () => {
  it('control: stays silent when the member set the chat to Nothing', async () => {
    state.cached = chatList('None');
    mount(useChatNewMessageSignal);
    receive(SignalMessages.ChatNewMessage, message());
    await settle();

    expect(state.played).toBe(0);
    expect(unreadFor(CHAT)).toBe(0);
    expect(state.ensureCalls).toBe(0);
  });
});

describe('being added to a conversation the member has set to Nothing', () => {
  const arrive = (level: string) => {
    mount(useChatNewRoomSignal);
    receive(SignalMessages.ChatNewRoom, {
      id: CHAT,
      ownerId: 99,
      createdAt: new Date().toISOString(),
      chatMembers: members(level),
    });
  };

  it('stays silent and leaves the badge to the server', () => {
    arrive('None');

    expect(state.played).toBe(0);
    expect(unreadFor(CHAT)).toBe(0);
    expect(state.invalidated).toContain('getUnreadCount');
  });

  it('control: rings and counts on All', () => {
    arrive('All');

    expect(state.played).toBe(1);
    expect(unreadFor(CHAT)).toBe(1);
  });
});
