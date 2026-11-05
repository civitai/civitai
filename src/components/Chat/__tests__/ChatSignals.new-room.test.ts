// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * A new conversation that reaches you as a Request counts in the header chat
 * badge (product decision), so its arrival refetches the unread count. Refetch,
 * not +1: the server is what leaves out a request from a blocked or banned sender.
 * It still plays no sound.
 */
const ME = 7;

const state = vi.hoisted(() => ({
  handler: undefined as ((payload: unknown) => void) | undefined,
  invalidated: [] as string[],
  unreadWrites: 0,
  played: 0,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7, username: 'me' }) }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({ chat: true }) }));
vi.mock('use-sound', () => ({ default: () => [() => state.played++] }));
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalConnection: (_: unknown, cb: (payload: unknown) => void) => {
    state.handler = cb;
  },
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  // eslint-disable-next-line local-rules/no-hand-enumerated-trpc-mock -- the hook only reaches useUtils, and the stub records which caches it touches
  trpc: {
    useUtils: () => ({
      chat: {
        getAllByUser: {
          invalidate: () => state.invalidated.push('getAllByUser'),
          setData: () => undefined,
        },
        getUnreadCount: {
          invalidate: () => state.invalidated.push('getUnreadCount'),
          setData: () => state.unreadWrites++,
        },
        getUserSettings: { getData: () => undefined },
      },
    }),
  },
}));

import { useChatNewRoomSignal } from '~/components/Chat/ChatSignals';

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  state.handler = undefined;
  state.invalidated = [];
  state.unreadWrites = 0;
  state.played = 0;
});

const mountAndReceive = (filteredAt: Date | null) => {
  function Probe() {
    useChatNewRoomSignal();
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(Probe)));
  if (!state.handler) throw new Error('the hook never subscribed to the signal');
  state.handler({
    id: 42,
    ownerId: 99,
    createdAt: new Date().toISOString(),
    chatMembers: [
      { userId: 99, filteredAt: null },
      { userId: ME, filteredAt },
    ],
  });
};

describe('a new conversation arriving over signals', () => {
  it('refetches the badge count when it arrives as a Request, silently', () => {
    mountAndReceive(new Date());

    expect(state.invalidated).toEqual(['getAllByUser', 'getUnreadCount']);
    expect(state.unreadWrites).toBe(0);
    expect(state.played).toBe(0);
  });

  it('control: an inbox conversation is counted in place and plays the sound', () => {
    mountAndReceive(null);

    expect(state.invalidated).toEqual([]);
    expect(state.unreadWrites).toBe(1);
    expect(state.played).toBe(1);
  });
});
