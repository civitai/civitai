import { describe, expect, it } from 'vitest';
import { getPostDetailVisibility } from '~/server/services/post-detail-visibility';
import { CollectionContributorPermission } from '~/shared/utils/prisma/enums';

describe('getPostDetailVisibility', () => {
  it('lets an anonymous viewer see published, scanned posts and nothing else', () => {
    const where = getPostDetailVisibility(undefined);

    expect(where).toEqual({
      OR: [{ publishedAt: { lt: expect.any(Date) }, nsfwLevel: { not: 0 } }],
    });
  });

  it('never emits a contributor or owner clause without a user id to scope it', () => {
    // Prisma drops `userId: undefined`, so an unscoped judge clause matches any collection
    // that has a manager — every draft entry in it becomes visible.
    expect(JSON.stringify(getPostDetailVisibility(undefined))).not.toContain('contributors');
    expect(JSON.stringify(getPostDetailVisibility(undefined))).not.toContain('userId');
  });

  it('adds the owner and the collection-manager branches, scoped to the viewer', () => {
    const where = getPostDetailVisibility({ id: 42, isModerator: false });

    expect(where.OR).toEqual([
      { userId: 42 },
      { publishedAt: { lt: expect.any(Date) }, nsfwLevel: { not: 0 } },
      {
        collectionId: { not: null },
        collection: {
          contributors: {
            some: { userId: 42, permissions: { has: CollectionContributorPermission.MANAGE } },
          },
        },
      },
    ]);
  });

  it('places no restriction on a moderator', () => {
    expect(getPostDetailVisibility({ id: 1, isModerator: true })).toEqual({ OR: undefined });
  });
});
