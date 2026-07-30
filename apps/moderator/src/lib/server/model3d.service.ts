import { REDIS_KEYS } from '@civitai/redis';
import { dbRead, dbWrite } from './db';
import { bustCachedObject } from './cache';
import { recordModActivity } from './mod-activity';

// The @unique thumbnail link from an image to its parent Model3D, for the review-card affordance
// (ported from the main app's model3d.getByThumbnailImageId + Model3DModAction).
export type Model3DRef = { id: number; name: string; status: string };

// Batched: which of these images are a Model3D's @unique thumbnail → the parent Model3D ref.
export async function getModel3DsByThumbnailImageIds(
  imageIds: number[]
): Promise<Record<number, Model3DRef>> {
  const ids = [...new Set(imageIds)];
  if (!ids.length) return {};
  const rows = await dbRead
    .selectFrom('Model3D')
    .select(['id', 'name', 'status', 'thumbnailImageId'])
    .where('thumbnailImageId', 'in', ids)
    .execute();
  const map: Record<number, Model3DRef> = {};
  for (const r of rows)
    if (r.thumbnailImageId != null)
      map[r.thumbnailImageId] = { id: r.id, name: r.name, status: r.status };
  return map;
}

// Unpublish a Model3D from the review queue (a mod reviewing its thumbnail). Ports unpublishModel3D's
// write; the owner-authz branch is dropped (the spoke is always a moderator). No-op on a missing/deleted
// model.
export async function unpublishModel3d({
  id,
  userId,
}: {
  id: number;
  userId: number;
}): Promise<void> {
  const existing = await dbRead
    .selectFrom('Model3D')
    .select(['id', 'deletedAt', 'userId'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!existing || existing.deletedAt) return;

  await dbWrite
    .updateTable('Model3D')
    .set({ status: 'Unpublished' })
    .where('id', '=', id)
    .execute();

  await recordModActivity({ userId, entityType: 'model3d', entityId: id, activity: 'unpublish' });

  // Unpublishing drops the owner's public model3d count — bust the three overview counters the main app
  // recomputes via userContentOverviewCache.refresh (base / :sfw / :public). Busting (lazy recompute on next
  // read) matches the article-restore pattern; only the model3d counters change here.
  const owner = existing.userId;
  await Promise.all([
    bustCachedObject(`${REDIS_KEYS.CACHES.OVERVIEW_USERS}:model3dCount`, owner),
    bustCachedObject(`${REDIS_KEYS.CACHES.OVERVIEW_USERS}:model3dCount:sfw`, owner),
    bustCachedObject(`${REDIS_KEYS.CACHES.OVERVIEW_USERS}:model3dCount:public`, owner),
  ]);
}
