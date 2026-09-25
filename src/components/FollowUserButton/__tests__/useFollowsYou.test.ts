// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type * as TrpcModule from '~/utils/trpc';

const act = (React as unknown as { act: typeof actType }).act;

// Like React Query, a disabled query still returns what is cached for its key, so the fake
// answers `cachedFollowsMe` whether or not the call is enabled.
const h = vi.hoisted(() => ({
  currentUser: undefined as { id: number } | undefined,
  followingIds: [] as number[] | undefined,
  cachedFollowsMe: undefined as boolean | undefined,
  followsMeCalls: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => h.currentUser }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    user: {
      getFollowingUsers: {
        useQuery: (_input: undefined, opts: { enabled: boolean }) =>
          opts.enabled && h.followingIds
            ? { data: h.followingIds, isSuccess: true }
            : { data: undefined, isSuccess: false },
      },
      getFollowsMe: {
        useQuery: (input: { id: number }, opts: { enabled: boolean }) => {
          h.followsMeCalls(input, opts);
          return { data: h.cachedFollowsMe };
        },
      },
    },
  },
}));

import {
  followButtonLabel,
  ownFollowerFollowsYou,
  ownListBlockRelations,
  useFollowButtonState,
} from '~/components/FollowUserButton/useFollowsYou';

const viewerId = 10;
const userId = 20;

type Args = Parameters<typeof useFollowButtonState>[0];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(args: Args) {
  let result: ReturnType<typeof useFollowButtonState> | undefined;
  function Probe() {
    result = useFollowButtonState(args);
    return null;
  }
  act(() => root.render(React.createElement(Probe)));
  return result!;
}

function requestsMade() {
  return h.followsMeCalls.mock.calls.filter(([, opts]) => opts.enabled).length;
}

const profile: Args = { userId, checkFollowsYou: true };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.currentUser = { id: viewerId };
  h.followingIds = [];
  h.cachedFollowsMe = true;
  h.followsMeCalls.mockReset();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('useFollowButtonState on the profile', () => {
  it('asks once, and reads Follow back for a follower', () => {
    expect(render(profile).label).toBe('Follow back');
    expect(requestsMade()).toBe(1);
    expect(h.followsMeCalls.mock.calls[0][0]).toEqual({ id: userId });
  });

  it('reads Follow for a non-follower', () => {
    h.cachedFollowsMe = false;
    expect(render(profile).label).toBe('Follow');
  });

  it('makes zero requests when logged out, and reads Follow', () => {
    h.currentUser = undefined;
    expect(render(profile).label).toBe('Follow');
    expect(requestsMade()).toBe(0);
  });

  it('makes zero requests on your own profile, even with a cached answer', () => {
    const state = render({ ...profile, userId: viewerId });
    expect(state.label).toBe('Follow');
    expect(requestsMade()).toBe(0);
  });

  it('makes zero requests for a mutual, and reads Unfollow', () => {
    h.followingIds = [userId];
    expect(render(profile)).toEqual({ following: true, label: 'Unfollow' });
    expect(requestsMade()).toBe(0);
  });

  it('makes zero requests while the following list is loading', () => {
    h.followingIds = undefined;
    render(profile);
    expect(requestsMade()).toBe(0);
  });
});

describe('useFollowButtonState on surfaces that did not opt in', () => {
  it('ignores an answer another surface cached for the same user', () => {
    expect(render({ userId }).label).toBe('Follow');
    expect(requestsMade()).toBe(0);
  });

  it('uses a known answer without a request', () => {
    h.cachedFollowsMe = undefined;
    expect(render({ userId, followsYou: true }).label).toBe('Follow back');
    expect(requestsMade()).toBe(0);
  });

  it('ignores a known answer when logged out', () => {
    h.currentUser = undefined;
    expect(render({ userId, followsYou: true }).label).toBe('Follow');
  });
});

describe('ownFollowerFollowsYou', () => {
  const base = { isOwnList: true, userId, hiddenLoaded: true, blockRelations: new Map() };

  it('is true for a follower on your own list', () => {
    expect(ownFollowerFollowsYou(base)).toBe(true);
  });

  it("is false on someone else's list", () => {
    expect(ownFollowerFollowsYou({ ...base, isOwnList: false })).toBe(false);
  });

  it('is false across a block', () => {
    expect(ownFollowerFollowsYou({ ...base, blockRelations: new Map([[userId, true]]) })).toBe(
      false
    );
  });

  it('is false across a block for moderators too', () => {
    const blockRelations = ownListBlockRelations({
      hiddenUsers: [],
      blockedUsers: [{ id: userId }],
      blockedByUsers: [],
    });
    expect(ownFollowerFollowsYou({ ...base, blockRelations })).toBe(false);
  });

  it('is false when the follower has blocked you', () => {
    const blockRelations = ownListBlockRelations({
      hiddenUsers: [],
      blockedUsers: [],
      blockedByUsers: [{ id: userId }],
    });
    expect(ownFollowerFollowsYou({ ...base, blockRelations })).toBe(false);
  });

  it('is false until hidden preferences have loaded', () => {
    expect(ownFollowerFollowsYou({ ...base, hiddenLoaded: false })).toBe(false);
  });
});

describe('followButtonLabel', () => {
  it('reads Unfollow for a mutual, as it did before Follow back', () => {
    expect(followButtonLabel({ following: true, followsYou: true })).toBe('Unfollow');
  });
});
