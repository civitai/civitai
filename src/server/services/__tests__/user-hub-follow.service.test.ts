import { beforeEach, describe, expect, it, vi } from 'vitest';

// Following a hub has two ways of failing QUIETLY:
//   - a follow row written for a hub the follower may not open, which the list read
//     would then happily render;
//   - a hub whose owner has made it Private again staying in every follower's
//     sidebar, because revocation is only ever applied at follow time.
// Neither raises anything at any layer, so only these pin them.

import {
  followUserHub,
  getFollowedHubs,
  hubViewerWhere,
  unfollowUserHub,
} from '~/server/services/user-hub.service';
import { hubLimits } from '~/server/schema/user-hub.schema';
import { Availability, UserHubSourceType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { encodeHubId } from '~/server/utils/hub-id';

const writerHub = dbMock.dbWrite.userHub.findFirst;
const followCount = dbMock.dbWrite.userHubFollow.count;
const followUpsert = dbMock.dbWrite.userHubFollow.upsert;
const followDeleteMany = dbMock.dbWrite.userHubFollow.deleteMany;
const followFindMany = dbMock.dbRead.userHubFollow.findMany;

const VIEWER = 3;
// A REAL encoding of hub 5, not a placeholder: the service decodes it, so a made-up
// string would turn every case below into a not-found and they would pass for the
// wrong reason.
const HUB_ID = 5;
const HUB_KEY = encodeHubId(HUB_ID);
const OWNER = 9;

const hubRow = (over: Partial<{ id: number; userId: number; name: string }> = {}) => ({
  id: 5,
  userId: OWNER,
  name: 'Theirs',
  index: 0,
  sort: 'Newest',
  period: 'AllTime',
  mediaTypes: [],
  availability: Availability.Public,
  forcedBrowsingLevel: 0,
  metadata: {},
  ...over,
});

/**
 * Stands in for the followed-hubs read, and actually APPLIES the `where` the service
 * emits rather than returning a canned list. Without that, dropping the viewer filter
 * from the service changes nothing any assertion can see — the fake would hand back
 * the same rows either way.
 */
function stubFollowedHubs(hubs: ReturnType<typeof hubRow>[]) {
  followFindMany.mockImplementation((args: any) => {
    const where = args?.where ?? {};
    const hubWhere = where.hub;
    const matches = hubs.filter((hub) => {
      if (!hubWhere) return true;
      const arms = hubWhere.OR;
      // `{}` — the moderator fragment — matches every hub, which is the shape this
      // read must NOT be given.
      if (!arms) return true;
      return arms.some(
        (arm: any) =>
          (arm.userId !== undefined && arm.userId === hub.userId) ||
          (arm.availability !== undefined && arm.availability === hub.availability)
      );
    });
    return Promise.resolve(matches.map((hub) => ({ hub })));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  followCount.mockResolvedValue(0);
  followUpsert.mockResolvedValue({ userId: VIEWER, hubId: 5 });
  followDeleteMany.mockResolvedValue({ count: 1 });
  stubFollowedHubs([]);
});

describe('followUserHub', () => {
  it('refuses an INT where the key goes — the encoding is worthless otherwise', async () => {
    // `getFollowed` returns each hub's `key`. While follow took an int, any signed-in
    // caller could follow public hub 1..N and read the keys back for the price of
    // counting — defeating the URL encoding without touching the salt. The hub lookup
    // must not even run.
    await expect(followUserHub({ key: String(HUB_ID), userId: VIEWER })).rejects.toThrow(
      /not found/i
    );
    await expect(unfollowUserHub({ key: String(HUB_ID), userId: VIEWER })).rejects.toThrow(
      /not found/i
    );

    expect(dbMock.dbWrite.userHub.findFirst).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.userHubFollow.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a hub this viewer cannot open, and writes nothing', async () => {
    // A private hub belonging to someone else does not match `hubViewerWhere`, so the
    // scoped read returns nothing. The refusal has to be a NOT-FOUND with no row
    // written — a follow row here is a pointer to content its holder will never be
    // shown, and it would come back the day the read filter is relaxed.
    writerHub.mockResolvedValue(null);

    await expect(followUserHub({ key: HUB_KEY, userId: VIEWER })).rejects.toThrow();
    expect(followUpsert).not.toHaveBeenCalled();
  });

  it('reads the hub through hubViewerWhere, on the WRITER', async () => {
    writerHub.mockResolvedValue({ id: 5, userId: OWNER });

    await followUserHub({ key: HUB_KEY, userId: VIEWER });

    expect(writerHub).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5, ...hubViewerWhere({ userId: VIEWER }) },
      })
    );
    // Asserted literally as well, so this cannot pass by both sides being wrong the
    // same way — `hubViewerWhere` is imported into the assertion above.
    expect(writerHub.mock.calls[0][0].where).toStrictEqual({
      id: 5,
      OR: [{ userId: VIEWER }, { availability: Availability.Public }],
    });
  });

  it('never passes isModerator: a view privilege is not a follow privilege', async () => {
    writerHub.mockResolvedValue({ id: 5, userId: OWNER });

    await followUserHub({ key: HUB_KEY, userId: VIEWER });

    // `hubViewerWhere({ isModerator: true })` is `{}`. If it ever reaches this read,
    // the `OR` disappears and a moderator can follow anything.
    expect(writerHub.mock.calls[0][0].where.OR).toHaveLength(2);
  });

  it('refuses your own hub', async () => {
    writerHub.mockResolvedValue({ id: 5, userId: VIEWER });

    await expect(followUserHub({ key: HUB_KEY, userId: VIEWER })).rejects.toThrow(/your own hub/i);
    expect(followUpsert).not.toHaveBeenCalled();
  });

  it('refuses once the viewer is at the cap', async () => {
    writerHub.mockResolvedValue({ id: 5, userId: OWNER });
    followCount.mockResolvedValue(hubLimits.followedHubs);

    await expect(followUserHub({ key: HUB_KEY, userId: VIEWER })).rejects.toThrow(/at most/i);
    expect(followUpsert).not.toHaveBeenCalled();
  });

  it('is idempotent — a second click is not an error', async () => {
    writerHub.mockResolvedValue({ id: 5, userId: OWNER });

    await expect(followUserHub({ key: HUB_KEY, userId: VIEWER })).resolves.toStrictEqual({
      hubId: 5,
      following: true,
    });
    expect(followUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_hubId: { userId: VIEWER, hubId: 5 } },
        create: { userId: VIEWER, hubId: 5 },
      })
    );
  });
});

describe('getFollowedHubs', () => {
  it('drops a hub whose owner has made it Private again', async () => {
    // The revocation case, and the reason the filter is on the READ: the follow row
    // still exists, and nothing deletes it when availability flips.
    stubFollowedHubs([
      hubRow({ id: 5, name: 'Still public' }),
      { ...hubRow({ id: 6, name: 'Went private' }), availability: Availability.Private },
    ]);

    const hubs = await getFollowedHubs({ userId: VIEWER });

    expect(hubs.map((hub) => hub.id)).toStrictEqual([5]);
  });

  it('scopes the read to the caller and to what they may open', async () => {
    await getFollowedHubs({ userId: VIEWER });

    expect(followFindMany.mock.calls[0][0].where).toStrictEqual({
      userId: VIEWER,
      hub: hubViewerWhere({ userId: VIEWER }),
    });
  });

  it('orders by hub name, like the owned list', async () => {
    expect(followFindMany).not.toHaveBeenCalled();
    await getFollowedHubs({ userId: VIEWER });
    expect(followFindMany.mock.calls[0][0].orderBy).toStrictEqual({ hub: { name: 'asc' } });
  });

  it('fetches neither the owner nor the sources — the rail renders a name and counts', async () => {
    // The sources are the payload: every hub in the rail carrying its whole list is
    // what this list shape exists to avoid, and a `select` that quietly grows them
    // back reads as a working list everywhere else.
    await getFollowedHubs({ userId: VIEWER });

    const select = followFindMany.mock.calls[0][0].select.hub.select;
    expect(select.user).toBeUndefined();
    expect(select.sources).toBeUndefined();
    expect(select.name).toBe(true);
  });

  it('returns the same summary shape the owned list does', async () => {
    stubFollowedHubs([{ ...hubRow({ id: 5 }), metadata: { description: 'hi' } }]);
    dbMock.dbRead.userHubSource.groupBy.mockResolvedValue([
      {
        hubId: 5,
        type: UserHubSourceType.User,
        enabled: true,
        exclude: false,
        _count: { _all: 2 },
      },
      // Switched off by the owner, so it fills nothing and is not counted for anyone.
      {
        hubId: 5,
        type: UserHubSourceType.Tag,
        enabled: false,
        exclude: false,
        _count: { _all: 1 },
      },
    ]);

    const [hub] = await getFollowedHubs({ userId: VIEWER });

    expect(hub.description).toBe('hi');
    expect(hub.isOwner).toBe(false);
    expect(hub.sourceCounts).toStrictEqual({ User: 2 });
    // A non-owner is told what fills the feed and nothing else: counting the owner's
    // switched-off source here would publish part of their curation by arithmetic.
    expect(hub.sourceCount).toBe(2);
    expect(hub).not.toHaveProperty('metadata');
  });
});

describe('unfollowUserHub', () => {
  it('deletes the CALLER’s row, scoped on the delete itself', async () => {
    await unfollowUserHub({ key: HUB_KEY, userId: VIEWER });

    // `userId` on the DELETE, not a lookup then a delete by id: without it this
    // unfollows the hub for every follower.
    expect(followDeleteMany).toHaveBeenCalledWith({ where: { userId: VIEWER, hubId: 5 } });
  });

  it('reports nothing removed when the row was already gone', async () => {
    followDeleteMany.mockResolvedValue({ count: 0 });

    await expect(unfollowUserHub({ key: HUB_KEY, userId: VIEWER })).resolves.toStrictEqual({
      hubId: 5,
      following: false,
      removed: false,
    });
  });
});
