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
import { Availability } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const writerHub = dbMock.dbWrite.userHub.findFirst;
const followCount = dbMock.dbWrite.userHubFollow.count;
const followUpsert = dbMock.dbWrite.userHubFollow.upsert;
const followDeleteMany = dbMock.dbWrite.userHubFollow.deleteMany;
const followFindMany = dbMock.dbRead.userHubFollow.findMany;

const VIEWER = 3;
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
  sources: [],
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
  it('refuses a hub this viewer cannot open, and writes nothing', async () => {
    // A private hub belonging to someone else does not match `hubViewerWhere`, so the
    // scoped read returns nothing. The refusal has to be a NOT-FOUND with no row
    // written — a follow row here is a pointer to content its holder will never be
    // shown, and it would come back the day the read filter is relaxed.
    writerHub.mockResolvedValue(null);

    await expect(followUserHub({ hubId: 5, userId: VIEWER })).rejects.toThrow();
    expect(followUpsert).not.toHaveBeenCalled();
  });

  it('reads the hub through hubViewerWhere, on the WRITER', async () => {
    writerHub.mockResolvedValue({ id: 5, userId: OWNER });

    await followUserHub({ hubId: 5, userId: VIEWER });

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

    await followUserHub({ hubId: 5, userId: VIEWER });

    // `hubViewerWhere({ isModerator: true })` is `{}`. If it ever reaches this read,
    // the `OR` disappears and a moderator can follow anything.
    expect(writerHub.mock.calls[0][0].where.OR).toHaveLength(2);
  });

  it('refuses your own hub', async () => {
    writerHub.mockResolvedValue({ id: 5, userId: VIEWER });

    await expect(followUserHub({ hubId: 5, userId: VIEWER })).rejects.toThrow(/your own hub/i);
    expect(followUpsert).not.toHaveBeenCalled();
  });

  it('refuses once the viewer is at the cap', async () => {
    writerHub.mockResolvedValue({ id: 5, userId: OWNER });
    followCount.mockResolvedValue(hubLimits.followedHubs);

    await expect(followUserHub({ hubId: 5, userId: VIEWER })).rejects.toThrow(/at most/i);
    expect(followUpsert).not.toHaveBeenCalled();
  });

  it('is idempotent — a second click is not an error', async () => {
    writerHub.mockResolvedValue({ id: 5, userId: OWNER });

    await expect(followUserHub({ hubId: 5, userId: VIEWER })).resolves.toStrictEqual({
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

  it('does not join the owner — the rail renders a name and a source count', async () => {
    await getFollowedHubs({ userId: VIEWER });

    const select = followFindMany.mock.calls[0][0].select.hub.select;
    expect(select.user).toBeUndefined();
    expect(select.name).toBe(true);
    expect(select.sources).toBeTruthy();
  });

  it('returns the same detail shape the owned list does', async () => {
    stubFollowedHubs([
      { ...hubRow({ id: 5 }), metadata: { description: 'hi' }, sources: [{ enabled: false }] },
    ]);

    const [hub] = await getFollowedHubs({ userId: VIEWER });

    expect(hub.description).toBe('hi');
    // Not the owner, so a source the owner switched off is not published to them.
    expect(hub.isOwner).toBe(false);
    expect(hub.sources).toStrictEqual([]);
    expect(hub).not.toHaveProperty('metadata');
  });
});

describe('unfollowUserHub', () => {
  it('deletes the CALLER’s row, scoped on the delete itself', async () => {
    await unfollowUserHub({ hubId: 5, userId: VIEWER });

    // `userId` on the DELETE, not a lookup then a delete by id: without it this
    // unfollows the hub for every follower.
    expect(followDeleteMany).toHaveBeenCalledWith({ where: { userId: VIEWER, hubId: 5 } });
  });

  it('reports nothing removed when the row was already gone', async () => {
    followDeleteMany.mockResolvedValue({ count: 0 });

    await expect(unfollowUserHub({ hubId: 5, userId: VIEWER })).resolves.toStrictEqual({
      hubId: 5,
      following: false,
      removed: false,
    });
  });
});
