import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The live-author short-circuit's cost claims, which the real-Postgres parity suite next door
 * cannot see: that a viewer with nothing to show costs NO database read once the author set is
 * cached, and that an author who newly goes live is picked up by the next refresh — within the
 * cache's TTL, the accepted bound — and not before.
 * Which ROWS come back is that suite's job.
 */
const switchState = vi.hoisted(() => ({ on: true }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(async (flag: string) =>
    flag === 'creator-feed-shortcircuit' ? switchState.on : false
  ),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user.service', () => ({
  amIBlockedByUser: vi.fn(async () => false),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
  getCosmeticsForUsers: vi.fn(async () => ({})),
}));

import { getFollowedAnnouncements, resetLiveAuthorCache } from '../creator-announcement.service';

const VIEWER = 11;
const AUTHOR = 23;
const OTHER_AUTHOR = 37;

type Where = { userId?: unknown; profileOnly?: boolean; user?: unknown };
const findManyCalls = () =>
  dbMock.dbRead.announcement.findMany.mock.calls.map((c) => (c[0] as { where: Where }).where);
// The feed query is the one that filters through the author relation; the live-author read is not.
const feedQueries = () => findManyCalls().filter((w) => w.user !== undefined);
const liveAuthorReads = () => findManyCalls().filter((w) => w.user === undefined);

/** Every dbRead/dbWrite method this module can reach, summed. */
function dbCallCount() {
  return [
    dbMock.dbRead.announcement.findMany,
    dbMock.dbRead.announcement.findFirst,
    dbMock.dbRead.userEngagement.findMany,
    dbMock.dbRead.userAnnouncementMute.findMany,
  ].reduce((n, fn) => n + fn.mock.calls.length, 0);
}

let liveAuthorRows: { userId: number }[] = [];
let follows: { targetUserId: number }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  resetLiveAuthorCache();
  switchState.on = true;
  liveAuthorRows = [];
  follows = [];
  dbMock.dbRead.announcement.findMany.mockImplementation((async (args: { where: Where }) =>
    args.where.user === undefined ? liveAuthorRows : []) as never);
  dbMock.dbRead.userEngagement.findMany.mockImplementation((async () => follows) as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the live-author short-circuit', () => {
  it('makes no database read for an empty author set once it is cached', async () => {
    await getFollowedAnnouncements({ userId: VIEWER });
    // Positive control: the first call DID read the set (one read), so a zero below is the
    // cache working, not a spy that sees nothing.
    expect(liveAuthorReads()).toHaveLength(1);
    expect(dbCallCount()).toBe(1);

    vi.clearAllMocks();
    const page = await getFollowedAnnouncements({ userId: VIEWER });

    expect(page).toEqual({ items: [], nextCursor: undefined });
    expect(dbCallCount()).toBe(0);
  });

  it('stops after the follow read when the viewer follows none of the live authors', async () => {
    liveAuthorRows = [{ userId: AUTHOR }, { userId: OTHER_AUTHOR }];
    follows = [];

    await getFollowedAnnouncements({ userId: VIEWER });

    const followRead = dbMock.dbRead.userEngagement.findMany.mock.calls[0][0] as {
      where: { userId: number; type: string; targetUserId: { in: number[] } };
    };
    expect(followRead.where).toEqual({
      userId: VIEWER,
      type: 'Follow',
      targetUserId: { in: [AUTHOR, OTHER_AUTHOR] },
    });
    expect(feedQueries()).toHaveLength(0);
  });

  it('narrows the feed query to the intersection and keeps every viewer predicate', async () => {
    liveAuthorRows = [{ userId: AUTHOR }, { userId: OTHER_AUTHOR }];
    follows = [{ targetUserId: OTHER_AUTHOR }];

    await getFollowedAnnouncements({ userId: VIEWER });

    expect(feedQueries()).toHaveLength(1);
    const where = feedQueries()[0] as Where & { user: Record<string, unknown> };
    expect(where.userId).toEqual({ in: [OTHER_AUTHOR] });
    expect(where.user.announcementMutesReceived).toEqual({ none: { userId: VIEWER } });
    expect(where.user.engagingUsers).toEqual({
      none: { targetUserId: VIEWER, type: 'Block' },
    });
  });

  it('runs the feed unnarrowed, with no author read, when the switch is off', async () => {
    switchState.on = false;

    await getFollowedAnnouncements({ userId: VIEWER });

    expect(liveAuthorReads()).toHaveLength(0);
    expect(dbMock.dbRead.userEngagement.findMany).not.toHaveBeenCalled();
    expect(feedQueries()).toHaveLength(1);
    expect(feedQueries()[0].userId).toEqual({ not: null });
  });

  it('falls back to the unnarrowed feed when the author read fails', async () => {
    dbMock.dbRead.announcement.findMany.mockImplementation((async (args: { where: Where }) => {
      if (args.where.user === undefined) throw new Error('replica unavailable');
      return [];
    }) as never);

    await getFollowedAnnouncements({ userId: VIEWER });

    expect(feedQueries()).toHaveLength(1);
    expect(feedQueries()[0].userId).toEqual({ not: null });
  });

  it('an author who newly goes live reaches followers at the next refresh, within the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2031-03-04T05:06:07.000Z');
    vi.setSystemTime(start);
    follows = [{ targetUserId: AUTHOR }];

    // Cached empty: nobody is live.
    await getFollowedAnnouncements({ userId: VIEWER });
    expect(liveAuthorReads()).toHaveLength(1);

    // The author posts. Inside the TTL the cached set still answers, so the follower gets the
    // empty feed without a read — the accepted bounded delay.
    liveAuthorRows = [{ userId: AUTHOR }];
    vi.clearAllMocks();
    vi.setSystemTime(start + 29_000);
    await getFollowedAnnouncements({ userId: VIEWER });
    expect(dbCallCount()).toBe(0);

    // Past the TTL the set is re-read, and the author's followers get the feed query.
    vi.setSystemTime(start + 31_000);
    await getFollowedAnnouncements({ userId: VIEWER });
    expect(liveAuthorReads()).toHaveLength(1);
    expect(dbMock.dbRead.userEngagement.findMany).toHaveBeenCalledTimes(1);
    expect(feedQueries()).toHaveLength(1);
    expect(feedQueries()[0].userId).toEqual({ in: [AUTHOR] });
  });
});
