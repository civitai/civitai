// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * `bellLazyCreatorFeed`: the bell stops fetching the followed creator-announcements feed on
 * every page and counts the ids of its first page instead; the panel fetches the feed when it
 * opens.
 *
 * Mocked at the tRPC `useQuery` boundary, with the real feed / ids hooks, the real dismissal
 * store and the real account-level dismissal merge — so "which query is issued" is read off the
 * `enabled` each query was given, and the badge number is the real computation over both paths.
 * "The panel opens" is modelled as the panel's own hook call, `useQueryFollowedAnnouncements(true)`
 * — what `NotificationsComposed` runs when the drawer mounts — not by rendering the drawer.
 */
const state = vi.hoisted(() => ({
  flags: { creatorAnnouncements: true, bellLazyCreatorFeed: false } as Record<string, boolean>,
  // The server's answer for the followed feed's first page, and the dismissals the account holds.
  feed: [] as { id: number }[],
  serverDismissed: [] as number[],
  platform: [] as { id: number; dismissed: boolean }[],
  // Every `enabled` each query was handed, in render order.
  feedEnabled: [] as boolean[],
  idsEnabled: [] as boolean[],
  // What the feed query has in cache: undefined until a call with enabled=true "fetched" it.
  feedCache: undefined as { items: { id: number }[] } | undefined,
  // Likewise for the ids query: fetched once, then stable, as React Query's data is.
  idsCache: undefined as number[] | undefined,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => state.flags }));
vi.mock('~/components/Announcements/announcements.utils', () => ({
  useGetAnnouncements: () => ({ data: state.platform, isLoading: false }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'user.checkNotifications': {
        useQuery: () => ({ data: { all: 4, comment: 4 }, isLoading: false }),
      },
      'announcement.getDismissedAnnouncements': {
        useQuery: () => ({ data: state.serverDismissed }),
      },
      'announcement.getFollowedAnnouncements': {
        useQuery: (_input: unknown, { enabled }: { enabled: boolean }) => {
          state.feedEnabled.push(enabled);
          // A disabled observer still reads whatever the cache holds, as React Query does.
          if (enabled) state.feedCache ??= { items: state.feed };
          return { data: state.feedCache, isLoading: false };
        },
      },
      'announcement.getFollowedAnnouncementIds': {
        useQuery: (_input: unknown, { enabled }: { enabled: boolean }) => {
          state.idsEnabled.push(enabled);
          if (enabled) state.idsCache ??= state.feed.map((x) => x.id);
          return { data: state.idsCache };
        },
      },
    }),
  };
});

import { useQueryFollowedAnnouncements } from '~/components/Announcements/creator-announcements.utils';
import {
  clearDismissedCreatorAnnouncements,
  dismissCreatorAnnouncements,
} from '~/components/Announcements/creator-announcement-dismissals';
import { useQueryNotificationsCount } from '~/components/Notifications/notifications.utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as T };
  const root = createRoot(document.createElement('div'));
  function Probe() {
    result.current = useHook();
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
  return {
    result,
    rerender: () => act(() => root.render(createElement(Probe))),
    unmount: () => act(() => root.unmount()),
  };
}

function badge(lazy: boolean) {
  state.flags.bellLazyCreatorFeed = lazy;
  const hook = renderHook(() => useQueryNotificationsCount());
  // A second render, so the effect-driven dismissal merge has landed before the number is read.
  hook.rerender();
  const { announcements, all } = hook.result.current;
  hook.unmount();
  return { announcements, all };
}

beforeEach(() => {
  state.flags = { creatorAnnouncements: true, bellLazyCreatorFeed: false };
  state.feed = [];
  state.serverDismissed = [];
  state.platform = [];
  state.feedEnabled = [];
  state.idsEnabled = [];
  state.feedCache = undefined;
  state.idsCache = undefined;
  clearDismissedCreatorAnnouncements();
});

describe('bellLazyCreatorFeed off', () => {
  it('fetches the feed from the bell and never issues the ids query', () => {
    state.feed = [{ id: 10 }, { id: 11 }];

    expect(badge(false).announcements).toBe(2);
    expect(state.feedEnabled).toContain(true);
    expect(state.idsEnabled.length).toBeGreaterThan(0);
    expect(state.idsEnabled).not.toContain(true);
  });
});

describe('bellLazyCreatorFeed on', () => {
  it('does not issue the feed query from the bell — only once the panel opens', () => {
    state.feed = [{ id: 10 }, { id: 11 }];

    expect(badge(true).announcements).toBe(2);
    // Positive control for the observer: the bell DID mount the feed hook, disabled.
    expect(state.feedEnabled.length).toBeGreaterThan(0);
    expect(state.feedEnabled).not.toContain(true);
    expect(state.idsEnabled).toContain(true);

    const panel = renderHook(() => useQueryFollowedAnnouncements(true));
    expect(state.feedEnabled.at(-1)).toBe(true);
    expect(panel.result.current.announcements.map((x) => x.id)).toEqual([10, 11]);
    panel.unmount();
  });

  // Pairwise-distinct ids across the feed, the local dismissals, the server dismissals and the
  // platform rows, so a badge that counted the wrong set, skipped either dismissal source or
  // dropped the platform half reads a different number.
  const cases: {
    name: string;
    feed: number[];
    local: number[];
    server: number[];
    platform: { id: number; dismissed: boolean }[];
    expected: number;
  }[] = [
    { name: 'nothing followed', feed: [], local: [], server: [], platform: [], expected: 0 },
    {
      name: 'three live, none dismissed',
      feed: [21, 22, 23],
      local: [],
      server: [],
      platform: [],
      expected: 3,
    },
    {
      name: 'one dismissed on this device',
      feed: [31, 32, 33],
      local: [32],
      server: [],
      platform: [],
      expected: 2,
    },
    {
      name: 'one dismissed on another device',
      feed: [41, 42, 43],
      local: [],
      server: [43],
      platform: [],
      expected: 2,
    },
    {
      name: 'both dismissal sources',
      feed: [51, 52, 53, 54],
      local: [51],
      server: [54],
      platform: [],
      expected: 2,
    },
    {
      name: 'everything dismissed',
      feed: [61, 62],
      local: [61],
      server: [62],
      platform: [],
      expected: 0,
    },
    {
      name: 'a dismissal of a row no longer live',
      feed: [71, 72],
      local: [79],
      server: [78],
      platform: [],
      expected: 2,
    },
    {
      name: 'with platform announcements',
      feed: [81, 82],
      local: [],
      server: [82],
      platform: [
        { id: 5, dismissed: false },
        { id: 6, dismissed: true },
      ],
      expected: 2,
    },
  ];

  it.each(cases)('counts what the feed-fetching bell counted: $name', (c) => {
    const arrange = () => {
      state.feed = c.feed.map((id) => ({ id }));
      state.serverDismissed = c.server;
      state.platform = c.platform;
      state.feedCache = undefined;
      state.idsCache = undefined;
      clearDismissedCreatorAnnouncements();
      if (c.local.length) dismissCreatorAnnouncements(c.local);
    };

    arrange();
    const before = badge(false);
    arrange();
    const after = badge(true);

    expect(before.announcements).toBe(c.expected);
    expect(after).toEqual(before);
  });

  it('counts the panel’s rows once the panel has loaded them', () => {
    // The ids were fetched first; the panel then loads a feed that has gained a row. The badge
    // must count the list the panel shows, not the older ids beside it.
    state.feed = [{ id: 91 }];
    state.flags.bellLazyCreatorFeed = true;
    const bell = renderHook(() => useQueryNotificationsCount());
    expect(bell.result.current.announcements).toBe(1);

    state.feed = [{ id: 91 }, { id: 92 }];
    const panel = renderHook(() => useQueryFollowedAnnouncements(true));
    bell.rerender();

    expect(bell.result.current.announcements).toBe(2);
    panel.unmount();
    bell.unmount();
  });
});
