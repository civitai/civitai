import { dbRead, dbWrite } from '~/server/db/client';
import type { EventViewer } from '~/server/events/event-access';
import { canReadCollectionItems } from '~/server/services/collection-item-access';
import { getUserCollectionPermissionsById } from '~/server/services/collection.service';
import { CollectionReadConfiguration } from '~/shared/utils/prisma/enums';

/**
 * Who a Collection home block's collection may be shown to:
 * - `shared`: anyone; the answer does not depend on the viewer and may be cached for everyone;
 * - `viewer`: this viewer only; it must not reach a shared cache;
 * - `none`: answered as a missing block.
 *
 * Shared: a system block, a Public collection, or an Unlisted one the block's owner owns. Anything
 * else is shown only to a viewer who may read the collection's items, and someone else's Unlisted
 * collection only to the block's owner, the collection's managers and moderators.
 */
export type CollectionBlockAudience = 'shared' | 'viewer' | 'none';

export async function getCollectionBlockAudience({
  blockUserId,
  collectionId,
  viewer,
}: {
  blockUserId: number;
  collectionId: number | undefined;
  viewer: EventViewer;
}): Promise<CollectionBlockAudience> {
  if (!collectionId) return 'none';
  if (blockUserId === -1) return 'shared';

  const findArgs = { where: { id: collectionId }, select: { read: true, userId: true } } as const;
  // The primary when the replica has not caught up with a collection created moments ago.
  const collection =
    (await dbRead.collection.findUnique(findArgs)) ??
    (await dbWrite.collection.findUnique(findArgs));
  if (!collection) return 'none';

  const unlisted = collection.read === CollectionReadConfiguration.Unlisted;
  if (collection.read === CollectionReadConfiguration.Public) return 'shared';
  if (unlisted && collection.userId === blockUserId) return 'shared';

  if (!viewer?.id) return 'none';
  const permissions = await getUserCollectionPermissionsById({
    id: collectionId,
    userId: viewer.id,
    isModerator: viewer.isModerator,
  });
  if (!canReadCollectionItems(permissions)) return 'none';
  if (unlisted && viewer.id !== blockUserId && !permissions.manage && !viewer.isModerator)
    return 'none';
  return 'viewer';
}
