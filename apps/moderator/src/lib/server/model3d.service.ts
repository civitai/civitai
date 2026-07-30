import { REDIS_KEYS } from '@civitai/redis';
import { dbRead, dbWrite } from './db';
import { bustCachedObject } from './cache';
import { recordModActivity } from './mod-activity';

export type Model3DRef = { id: number; name: string; status: string };

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

  await dbWrite.updateTable('Model3D').set({ status: 'Unpublished' }).where('id', '=', id).execute();

  await recordModActivity({ userId, entityType: 'model3d', entityId: id, activity: 'unpublish' });

  const owner = existing.userId;
  await Promise.all([
    bustCachedObject(`${REDIS_KEYS.CACHES.OVERVIEW_USERS}:model3dCount`, owner),
    bustCachedObject(`${REDIS_KEYS.CACHES.OVERVIEW_USERS}:model3dCount:sfw`, owner),
    bustCachedObject(`${REDIS_KEYS.CACHES.OVERVIEW_USERS}:model3dCount:public`, owner),
  ]);
}
