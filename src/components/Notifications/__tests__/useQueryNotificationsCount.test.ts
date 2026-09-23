// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import type * as DismissalsModule from '~/components/Announcements/creator-announcement-dismissals';

/**
 * The reported bug was WIRING, not arithmetic: the creator half never reached the counter
 * (FD #72072). `withAnnouncementCounts` is unit-tested next door, but a test of it cannot
 * see the hook decline to pass the followed set — so this file drives the hook itself.
 *
 * `selectUndismissedAnnouncements` is left REAL via importOriginal. Mocking it would leave
 * the dismissal filter — the half of this that decides whether the badge can ever clear —
 * untested with the suite green.
 */
const state = vi.hoisted(() => ({
  currentUser: { id: 1 } as { id: number } | null,
  counts: undefined as Record<string, number> | undefined,
  countsLoading: false,
  platform: [] as { id: number; dismissed: boolean }[],
  platformLoading: false,
  followed: [] as { id: number }[],
  dismissedCreatorIds: [] as number[],
  followedEnabled: undefined as boolean | undefined,
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => state.currentUser,
}));
vi.mock('~/components/Announcements/announcements.utils', () => ({
  useGetAnnouncements: () => ({ data: state.platform, isLoading: state.platformLoading }),
}));
vi.mock('~/components/Announcements/creator-announcements.utils', () => ({
  useQueryFollowedAnnouncements: (enabled?: boolean) => {
    state.followedEnabled = enabled;
    return { announcements: state.followed, isLoading: false };
  },
}));
vi.mock('~/components/Announcements/creator-announcement-dismissals', async (importOriginal) => ({
  ...(await importOriginal<typeof DismissalsModule>()),
  useDismissedCreatorAnnouncements: () => state.dismissedCreatorIds,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    user: {
      checkNotifications: {
        useQuery: () => ({ data: state.counts, isLoading: state.countsLoading }),
      },
    },
  },
}));

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
  return result;
}

const counts = () => renderHook(() => useQueryNotificationsCount()).current;

beforeEach(() => {
  state.currentUser = { id: 1 };
  state.counts = { all: 4, comment: 4 };
  state.countsLoading = false;
  state.platform = [];
  state.platformLoading = false;
  state.followed = [];
  state.dismissedCreatorIds = [];
  state.followedEnabled = undefined;
});

describe('useQueryNotificationsCount', () => {
  it('passes the followed announcements through to the count', () => {
    // The regression itself: before the fix these three were fetched, rendered in the tab,
    // and never counted. A hook that stops passing them reads 0 here.
    state.followed = [{ id: 10 }, { id: 11 }, { id: 12 }];

    expect(counts().announcements).toBe(3);
    expect(counts().all).toBe(7);
  });

  it('counts both halves together', () => {
    state.platform = [{ id: 1, dismissed: false }];
    state.followed = [{ id: 10 }, { id: 11 }];

    expect(counts().announcements).toBe(3);
  });

  it('drops a dismissed creator announcement from the count', () => {
    state.followed = [{ id: 10 }, { id: 11 }];
    state.dismissedCreatorIds = [10];

    expect(counts().announcements).toBe(1);
  });

  it('clears once every creator announcement is dismissed', () => {
    state.followed = [{ id: 10 }, { id: 11 }];
    state.dismissedCreatorIds = [10, 11];

    expect(counts().announcements).toBe(0);
    expect(counts().all).toBe(4);
  });

  it('still excludes dismissed platform announcements', () => {
    state.platform = [
      { id: 1, dismissed: true },
      { id: 2, dismissed: false },
    ];

    expect(counts().announcements).toBe(1);
  });

  it('gates the followed query on there being a signed-in user', () => {
    // `getFollowedAnnouncements` is a protected procedure; an ungated call is an
    // UNAUTHORIZED per anonymous page view.
    state.currentUser = null;

    counts();

    expect(state.followedEnabled).toBe(false);
  });

  it('reports zero while the platform counts are still loading', () => {
    state.countsLoading = true;
    state.followed = [{ id: 10 }];

    expect(counts().all).toBe(0);
    expect(counts().announcements).toBe(0);
  });
});
