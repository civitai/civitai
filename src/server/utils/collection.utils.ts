import { dbWrite } from '~/server/db/client';

export type CollectionEntityType = 'image' | 'model' | 'post' | 'article';

/**
 * Removes an entity (image, model, post, or article) from all collections it's part of.
 * This is called when an entity is deleted or marked as ToS violation.
 *
 * @param entityType - The type of entity ('image', 'model', 'post', 'article')
 * @param entityId - The ID of the entity to remove from collections
 */
export async function removeEntityFromAllCollections(
  entityType: CollectionEntityType,
  entityId: number
) {
  // Build the where clause based on entity type
  const whereClause = {
    imageId: entityType === 'image' ? entityId : undefined,
    modelId: entityType === 'model' ? entityId : undefined,
    postId: entityType === 'post' ? entityId : undefined,
    articleId: entityType === 'article' ? entityId : undefined,
  };

  // Delete all collection items for this entity
  // If entity is not in any collections, this is a no-op (0 rows affected)
  await dbWrite.collectionItem.deleteMany({
    where: whereClause,
  });
}
