import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { getHiddenImagesForUser } from '~/server/services/user-preferences.service';
import { Availability, ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * A profile cover is uploaded to the profile, not published as a post, so its
 * `Image.postId` is null. Every surface that could have listed it filters on
 * `postId IS NOT NULL` (both feed paths) and `getImage` 404s a post-less image
 * for anyone but its owner — so hiding a cover removed the only thing that could
 * unhide it. This query is the recovery surface, and the properties that make it
 * one are: it does not filter on `postId`, it is scoped to the caller's own
 * `Hide` rows, and it lists a row even when the image itself may no longer be
 * shown. (ClickUp 868m5qc3b)
 */

const viewerId = 42;
const targetUserId = 7;
const COVER_ID = 100;
const SFW_COVER_ID = 101;

const past = new Date('2020-01-01');
const future = new Date('2999-01-01');

const row = (
  id: number,
  postId: number | null,
  overrides: Record<string, unknown> = {},
  post: Record<string, unknown> | null = null
) => ({
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
    tosViolation: false,
    needsReview: null,
    ingestion: ImageIngestionStatus.Scanned,
    nsfwLevelLocked: false,
    post: postId
      ? { publishedAt: past, availability: Availability.Public, userId: targetUserId, ...post }
      : null,
    ...overrides,
  },
});

const posted = (id: number, overrides?: Record<string, unknown>, post?: Record<string, unknown>) =>
  row(id, 5000 + id, overrides, post);

describe('getHiddenImagesForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.userProfile.findUnique.mockResolvedValue({
      coverImageId: COVER_ID,
      sfwCoverImageId: SFW_COVER_ID,
    } as never);
  });

  it('returns a post-less image and marks the one that is the profile cover', async () => {
    dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([
      row(COVER_ID, null),
      posted(200),
    ] as never);

    const { items } = await getHiddenImagesForUser({ userId: viewerId, targetUserId });

    expect(items.map((x) => x.id)).toEqual([COVER_ID, 200]);
    expect(items.find((x) => x.id === COVER_ID)?.isProfileCover).toBe(true);
    expect(items.find((x) => x.id === 200)?.isProfileCover).toBe(false);
  });

  // The green domain serves `sfwCoverImage` in the header, so that is the image a
  // green-domain viewer hides — labelling only `coverImageId` would leave it
  // indistinguishable from an ordinary hidden image.
  it('marks the sfw cover as a cover too', async () => {
    dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([row(SFW_COVER_ID, null)] as never);

    const { items } = await getHiddenImagesForUser({ userId: viewerId, targetUserId });

    expect(items[0].isProfileCover).toBe(true);
    expect(items[0].canViewMedia).toBe(true);
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

  describe('media is withheld once the image is no longer viewable, but the row stays', () => {
    it.each([
      ['a ToS takedown', posted(1, { tosViolation: true })],
      ['a Blocked rating', posted(2, { nsfwLevel: NsfwLevel.Blocked })],
      ['an unscanned image', posted(3, { ingestion: ImageIngestionStatus.Pending })],
      ['an unpublished post', posted(4, {}, { publishedAt: null })],
      ['a scheduled post', posted(5, {}, { publishedAt: future })],
      ['a private post', posted(6, {}, { availability: Availability.Private })],
      // Post-less and not a cover: `getImage` serves this to its owner alone.
      ['a post-less non-cover upload', row(7, null)],
    ])('%s', async (_label, hidden) => {
      dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([hidden] as never);

      const { items } = await getHiddenImagesForUser({ userId: viewerId, targetUserId });

      expect(items).toHaveLength(1);
      expect(items[0].canViewMedia).toBe(false);
      expect(items[0].url).toBeNull();
    });

    it('keeps the media for a published, scanned, public image', async () => {
      dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([posted(8)] as never);

      const { items } = await getHiddenImagesForUser({ userId: viewerId, targetUserId });

      expect(items[0].canViewMedia).toBe(true);
      expect(items[0].url).toBe('url-8');
    });

    it('lets the owner see their own image whatever its state', async () => {
      dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([
        posted(9, { userId: viewerId, tosViolation: true }),
      ] as never);

      const { items } = await getHiddenImagesForUser({ userId: viewerId, targetUserId: viewerId });

      expect(items[0].canViewMedia).toBe(true);
    });
  });

  it('reports hasMore and trims to the limit rather than silently truncating', async () => {
    dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([
      posted(1),
      posted(2),
      posted(3),
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
    dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([posted(1)] as never);

    const { items, hasMore } = await getHiddenImagesForUser({
      userId: viewerId,
      targetUserId,
      limit: 2,
    });

    expect(items).toHaveLength(1);
    expect(hasMore).toBe(false);
  });
});
