import { dbRead, dbWrite } from './db';
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
// model. Main-app userContentOverviewCache refresh (Redis) is deferred: TODO(moderator-migration).
export async function unpublishModel3d({
  id,
  userId,
}: {
  id: number;
  userId: number;
}): Promise<void> {
  const existing = await dbRead
    .selectFrom('Model3D')
    .select(['id', 'deletedAt'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!existing || existing.deletedAt) return;

  await dbWrite
    .updateTable('Model3D')
    .set({ status: 'Unpublished' })
    .where('id', '=', id)
    .execute();

  await recordModActivity({ userId, entityType: 'model3d', entityId: id, activity: 'unpublish' });
}
