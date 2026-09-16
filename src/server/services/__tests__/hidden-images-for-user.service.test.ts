import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getHiddenImagesForUser } from '~/server/services/user-preferences.service';

/**
 * A profile cover is uploaded to the profile, not published as a post, so its
 * `Image.postId` is null. Every surface that could have listed it filters on
 * `postId IS NOT NULL` (both feed paths) and `getImage` 404s a post-less image
 * for anyone but its owner — so hiding a cover removed the only thing that could
 * unhide it. This query is the recovery surface, and the two properties that
 * make it one are: it does not filter on `postId`, and it is scoped to the
 * caller's own `Hide` rows. (ClickUp 868m5qc3b)
 */

const viewerId = 42;
const targetUserId = 7;
const COVER_ID = 100;

const row = (id: number, postId: number | null) => ({
  createdAt: new Date('2026-09-01'),
  image: {
    id,
    name: `image-${id}`,
    url: `url-${id}`,
    nsfwLevel: 1,
    width: 100,
    height: 100,
    hash: 'hash',
    type: 'image',
    postId,
    userId: targetUserId,
  },
});

describe('getHiddenImagesForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.userProfile.findUnique.mockResolvedValue({ coverImageId: COVER_ID } as never);
  });

  it('returns a post-less image and marks the one that is the profile cover', async () => {
    dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([
      row(COVER_ID, null),
      row(200, 5000),
    ] as never);

    const { items } = await getHiddenImagesForUser({ userId: viewerId, targetUserId });

    expect(items.map((x) => x.id)).toEqual([COVER_ID, 200]);
    expect(items.find((x) => x.id === COVER_ID)?.isProfileCover).toBe(true);
    expect(items.find((x) => x.id === 200)?.isProfileCover).toBe(false);
  });

  it('asks only for the caller own Hide rows on the target user images', async () => {
    dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([] as never);

    await getHiddenImagesForUser({ userId: viewerId, targetUserId });

    const { where } = dbMock.dbRead.imageEngagement.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(where).toEqual({ userId: viewerId, type: 'Hide', image: { userId: targetUserId } });
    // Nothing may narrow this by post: that is what stranded the covers.
    expect(JSON.stringify(where)).not.toContain('postId');
  });

  it('reports hasMore and trims to the limit rather than silently truncating', async () => {
    dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([
      row(1, 1),
      row(2, 2),
      row(3, 3),
    ] as never);

    const { items, hasMore } = await getHiddenImagesForUser({
      userId: viewerId,
      targetUserId,
      limit: 2,
    });

    expect(dbMock.dbRead.imageEngagement.findMany.mock.calls[0][0]).toMatchObject({ take: 3 });
    expect(items).toHaveLength(2);
    expect(hasMore).toBe(true);
  });

  it('does not report hasMore when the page is not full', async () => {
    dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([row(1, 1)] as never);

    const { items, hasMore } = await getHiddenImagesForUser({
      userId: viewerId,
      targetUserId,
      limit: 2,
    });

    expect(items).toHaveLength(1);
    expect(hasMore).toBe(false);
  });
});
