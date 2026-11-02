import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The live-author short-circuit's cost claims, which the real-Postgres parity suite next door
 * cannot see: that a viewer with nothing to show costs NO database read once the author set is
 * cached, and that a save on this pod reaches its followers without waiting out the cache.
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
vi.mock('~/server/services/cover-image.service', () => ({
  resolveCoverImageId: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/util.service', () => ({ isImageOwner: vi.fn(async () => true) }));
vi.mock('~/server/utils/server-domain', () => ({ getAllServerHosts: () => [] }));

import {
  getFollowedAnnouncementIds,
  getFollowedAnnouncements,
  resetLiveAuthorCache,
  upsertCreatorAnnouncement,
} from '../creator-announcement.service';

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
    dbMock.dbWrite.announcement.create,
    dbMock.dbWrite.announcement.update,
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
  dbMock.dbWrite.announcement.create.mockResolvedValue({ id: 1 } as never);
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
    const ids = await getFollowedAnnouncementIds({ userId: VIEWER });

    expect(page).toEqual({ items: [], nextCursor: undefined });
    expect(ids).toEqual([]);
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

  it('a save on this pod reaches followers without waiting for the cached set to expire', async () => {
    follows = [{ targetUserId: AUTHOR }];
    // Cached empty: nobody is live.
    await getFollowedAnnouncements({ userId: VIEWER });
    expect(feedQueries()).toHaveLength(0);

    // The author posts. The replica the set is read from may not have the row yet, so the set
    // read keeps answering empty — the save itself has to be what puts the author back in.
    await upsertCreatorAnnouncement({
      userId: AUTHOR,
      title: 'Now live',
      content: 'Fresh',
      domain: ['all'],
      profileOnly: true, // spends nothing, so no allowance or transaction is involved
    } as never);
    vi.clearAllMocks();

    await getFollowedAnnouncements({ userId: VIEWER });

    expect(liveAuthorReads()).toHaveLength(0); // still the cached set
    const followRead = dbMock.dbRead.userEngagement.findMany.mock.calls[0][0] as {
      where: { targetUserId: { in: number[] } };
    };
    expect(followRead.where.targetUserId.in).toEqual([AUTHOR]);
    expect(feedQueries()).toHaveLength(1);
    expect(feedQueries()[0].userId).toEqual({ in: [AUTHOR] });
  });
});
