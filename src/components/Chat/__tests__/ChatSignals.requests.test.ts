// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * A Request counts in the header chat badge (product decision) but stays silent.
 * Its arrival, and each new message in it, refetch the unread count rather than
 * +1: only the server knows whether the sender is blocked or banned.
 */
const ME = 7;
const CHAT = 42;

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (payload: unknown) => void>,
  chats: [] as unknown[],
  invalidated: [] as string[],
  unreadWrites: 0,
  played: 0,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7, username: 'me' }) }));
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
          getData: () => state.chats,
          invalidate: () => state.invalidated.push('getAllByUser'),
          setData: () => undefined,
        },
        getInfiniteMessages: { setInfiniteData: () => undefined },
        getUnreadCount: {
          invalidate: () => state.invalidated.push('getUnreadCount'),
          setData: () => state.unreadWrites++,
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
  state.handlers = {};
  state.chats = [];
  state.invalidated = [];
  state.unreadWrites = 0;
  state.played = 0;
});

const mount = (hook: () => void) => {
  function Probe() {
    hook();
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(Probe)));
};

const members = (filteredAt: Date | null) => [
  { userId: 99, filteredAt: null, notifyLevel: 'All' },
  { userId: ME, filteredAt, notifyLevel: 'All' },
];

const receive = (message: SignalMessages, payload: unknown) => {
  const handler = state.handlers[message];
  if (!handler) throw new Error(`the hook never subscribed to ${message}`);
  handler(payload);
};

describe('a new conversation arriving over signals', () => {
  const arrive = (filteredAt: Date | null) => {
    mount(useChatNewRoomSignal);
    receive(SignalMessages.ChatNewRoom, {
      id: CHAT,
      ownerId: 99,
      createdAt: new Date().toISOString(),
      chatMembers: members(filteredAt),
    });
  };

  it('refetches the badge count when it arrives as a Request, silently', () => {
    arrive(new Date());

    expect(state.invalidated).toContain('getUnreadCount');
    expect(state.unreadWrites).toBe(0);
    expect(state.played).toBe(0);
  });

  it('control: an inbox conversation is counted in place and plays the sound', () => {
    arrive(null);

    expect(state.invalidated).toEqual([]);
    expect(state.unreadWrites).toBe(1);
    expect(state.played).toBe(1);
  });
});

describe('a new message arriving over signals', () => {
  const arrive = (filteredAt: Date | null) => {
    state.chats = [{ id: CHAT, chatMembers: members(filteredAt), messages: [] }];
    mount(useChatNewMessageSignal);
    receive(SignalMessages.ChatNewMessage, {
      id: 1000,
      chatId: CHAT,
      userId: 99,
      content: 'hello',
      contentType: 'Markdown',
      createdAt: new Date().toISOString(),
    });
  };

  it('refetches the badge count when the chat is a Request, silently', () => {
    arrive(new Date());

    expect(state.invalidated).toEqual(['getUnreadCount']);
    expect(state.unreadWrites).toBe(0);
    expect(state.played).toBe(0);
  });

  it('control: an inbox message is counted in place and plays the sound', () => {
    arrive(null);

    expect(state.invalidated).toEqual([]);
    expect(state.unreadWrites).toBe(1);
    expect(state.played).toBe(1);
  });
});
