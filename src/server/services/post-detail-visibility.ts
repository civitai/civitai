import type { Prisma } from '@prisma/client';
import { CollectionContributorPermission } from '~/shared/utils/prisma/enums';

/**
 * Which posts `getPostDetail` may return to a viewer.
 *
 * The owner and collection-manager branches are only added for a real viewer: Prisma drops a
 * `userId: undefined` filter, so for an anonymous caller the manager branch would match every post
 * in any collection that has a manager, published or not.
 */
export function getPostDetailVisibility(
  user: { id: number; isModerator?: boolean } | undefined
): Prisma.PostWhereInput {
  if (user?.isModerator) return { OR: undefined };

  const published: Prisma.PostWhereInput = {
    publishedAt: { lt: new Date() },
    nsfwLevel: { not: 0 },
  };
  if (!user) return { OR: [published] };

  return {
    OR: [
      { userId: user.id },
      published,
      // Collection judges see every post in the collection, whatever its level or status.
      {
        collectionId: { not: null },
        collection: {
          contributors: {
            some: { userId: user.id, permissions: { has: CollectionContributorPermission.MANAGE } },
          },
        },
      },
    ],
  };
}
