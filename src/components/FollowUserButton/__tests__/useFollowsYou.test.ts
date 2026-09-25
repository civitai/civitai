// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type * as TrpcModule from '~/utils/trpc';

const act = (React as unknown as { act: typeof actType }).act;

const h = vi.hoisted(() => ({
  currentUser: undefined as { id: number } | undefined,
  followsMe: false,
  useQuery: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => h.currentUser }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    user: {
      getFollowsMe: {
        useQuery: (input: { id: number }, opts: { enabled: boolean }) => {
          h.useQuery(input, opts);
          return { data: opts.enabled ? h.followsMe : undefined };
        },
      },
    },
  },
}));

import { followButtonLabel, useFollowsYou } from '~/components/FollowUserButton/useFollowsYou';

const viewerId = 10;
const userId = 20;

type Args = Parameters<typeof useFollowsYou>[0];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(args: Args) {
  let result: boolean | undefined;
  function Probe() {
    result = useFollowsYou(args);
    return null;
  }
  act(() => root.render(React.createElement(Probe)));
  return result;
}

function requestsMade() {
  return h.useQuery.mock.calls.filter(([, opts]) => opts.enabled).length;
}

const profile: Args = { userId, following: false, followingLoaded: true, checkFollowsYou: true };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.currentUser = { id: viewerId };
  h.followsMe = true;
  h.useQuery.mockReset();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('useFollowsYou on the profile', () => {
  it('asks once, and reports a follower', () => {
    expect(render(profile)).toBe(true);
    expect(requestsMade()).toBe(1);
    expect(h.useQuery.mock.calls[0][0]).toEqual({ id: userId });
  });

  it('makes zero requests when logged out', () => {
    h.currentUser = undefined;
    expect(render(profile)).toBe(false);
    expect(requestsMade()).toBe(0);
  });

  it('makes zero requests on your own profile', () => {
    expect(render({ ...profile, userId: viewerId })).toBe(false);
    expect(requestsMade()).toBe(0);
  });

  it('makes zero requests for a user you already follow', () => {
    expect(render({ ...profile, following: true })).toBe(false);
    expect(requestsMade()).toBe(0);
  });

  it('waits for the following list before asking', () => {
    render({ ...profile, followingLoaded: false });
    expect(requestsMade()).toBe(0);
  });

  it('makes zero requests on surfaces that did not opt in', () => {
    expect(render({ ...profile, checkFollowsYou: false })).toBe(false);
    expect(requestsMade()).toBe(0);
  });
});

describe('useFollowsYou with a known answer', () => {
  it('uses it without a request', () => {
    expect(render({ userId, following: false, followingLoaded: true, followsYou: true })).toBe(
      true
    );
    expect(requestsMade()).toBe(0);
  });

  it('ignores it when logged out', () => {
    h.currentUser = undefined;
    expect(render({ userId, following: false, followingLoaded: false, followsYou: true })).toBe(
      false
    );
  });
});

describe('followButtonLabel', () => {
  it('reads Follow back for a follower you do not follow', () => {
    expect(followButtonLabel({ following: false, followsYou: true })).toBe('Follow back');
  });

  it('reads Follow for a non-follower', () => {
    expect(followButtonLabel({ following: false, followsYou: false })).toBe('Follow');
  });

  it('reads Unfollow for a mutual, as it did before Follow back', () => {
    expect(followButtonLabel({ following: true, followsYou: true })).toBe('Unfollow');
  });
});
