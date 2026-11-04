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

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { isFlipt } from '~/server/flipt/client';
import {
  creatorFeedLiveAuthorsGauge,
  creatorFeedShortcircuitCounter,
  getFollowedAnnouncements,
  resetLiveAuthorCache,
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
    expect(creatorFeedShortcircuitCounter.inc).toHaveBeenCalledWith({ outcome: 'empty_set' });

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
    expect(creatorFeedShortcircuitCounter.inc).toHaveBeenCalledWith({ outcome: 'no_follows' });
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
    // The viewer sees nothing different, so these are the only trace of the fallback.
    expect(creatorFeedShortcircuitCounter.inc).toHaveBeenCalledWith({ outcome: 'fallback' });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'creator-feed-shortcircuit-fallback',
        type: 'warning',
        details: expect.objectContaining({ errorName: 'Error', error: 'replica unavailable' }),
      })
    );
  });

  it('records the narrowed decision and the set size it built, and no fallback', async () => {
    liveAuthorRows = [{ userId: AUTHOR }, { userId: OTHER_AUTHOR }, { userId: AUTHOR }];
    follows = [{ targetUserId: AUTHOR }];

    await getFollowedAnnouncements({ userId: VIEWER });

    // The narrowed path ran: the follow read happened.
    expect(dbMock.dbRead.userEngagement.findMany).toHaveBeenCalledTimes(1);
    // The gauge is how an ON window sees the set's size. Deduped: three rows, two authors.
    expect(creatorFeedLiveAuthorsGauge.set).toHaveBeenCalledWith({ domain: 'any' }, 2);
    expect(creatorFeedShortcircuitCounter.inc).toHaveBeenCalledWith({ outcome: 'narrowed' });
    // Negative control for the fallback test: a narrowing that worked logs nothing.
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
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

describe('the live-author set window', () => {
  const START = Date.parse('2031-03-04T05:06:07.000Z');
  /**
   * The one `field: { op: Date }` bound anywhere in a where tree. Read structurally rather than by
   * position, so the window can be built by any helper; more or fewer than one match throws, which
   * is what keeps a bound dropped or duplicated from reading as a pass.
   */
  function findBound(where: unknown, field: 'startsAt' | 'endsAt', op: 'lte' | 'gte'): Date {
    const found: Date[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        const bound = (value as Record<string, unknown> | null)?.[op];
        if (key === field && bound instanceof Date) found.push(bound);
        else walk(value);
      }
    };
    walk(where);
    if (found.length !== 1) throw new Error(`expected one ${field}.${op}, found ${found.length}`);
    return found[0];
  }
  const liveWhere = () =>
    (
      dbMock.dbRead.announcement.findMany.mock.calls.find(
        (c) => (c[0] as { where: Where }).where.user === undefined
      )?.[0] as { where: unknown }
    ).where;

  it('looks ahead two TTLs past startsAt and back one TTL past endsAt, from its own clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);

    await getFollowedAnnouncements({ userId: VIEWER });

    // Pinned literally: the start lookahead must outlast a set that lives one TTL past a slow
    // read (so 1x is too short), and the end lookback covers the feed's earlier clock reading.
    expect(findBound(liveWhere(), 'startsAt', 'lte')).toEqual(new Date(START + 60_000));
    expect(findBound(liveWhere(), 'endsAt', 'gte')).toEqual(new Date(START - 30_000));
  });

  it('keeps an author whose only row ends between the feed’s clock reading and the set build', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    // The author's only live row ends 1 ms after the feed reads its clock. The set is built
    // 5 ms later (simulated inside the switch read), when that row has already ended — yet the
    // feed query, which uses the earlier reading, still counts it as live.
    const endsAt = new Date(START + 1);
    dbMock.dbRead.announcement.findMany.mockImplementation((async (args: { where: Where }) => {
      if (args.where.user !== undefined) return [];
      const gte = findBound(args.where, 'endsAt', 'gte');
      return endsAt >= gte ? [{ userId: AUTHOR }] : [];
    }) as never);
    vi.mocked(isFlipt).mockImplementationOnce(async () => {
      vi.setSystemTime(START + 5);
      return true;
    });
    follows = [{ targetUserId: AUTHOR }];

    await getFollowedAnnouncements({ userId: VIEWER });

    expect(dbMock.dbRead.userEngagement.findMany).toHaveBeenCalledTimes(1);
    expect(feedQueries()).toHaveLength(1);
    expect(feedQueries()[0].userId).toEqual({ in: [AUTHOR] });
  });
});
