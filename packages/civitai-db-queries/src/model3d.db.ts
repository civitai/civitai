import type { Kysely, SelectType } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// `Model3D.status`, derived from the schema so this module needs no separate enum import.
type Model3DStatusValue = SelectType<DB['Model3D']['status']>;

// The @unique thumbnail link from an image to its parent Model3D, for the review-card affordance.
export type Model3DRef = { id: number; name: string; status: Model3DStatusValue };

// Batched: which of these images are a Model3D's @unique thumbnail → the parent Model3D ref, keyed by
// thumbnailImageId. Guards the empty-array case (no `IN ()`).
export async function getModel3DsByThumbnailImageIds(
  db: Kysely<DB>,
  imageIds: number[]
): Promise<Record<number, Model3DRef>> {
  const ids = [...new Set(imageIds)];
  if (!ids.length) return {};

  const rows = await db
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

// The DB write core of the moderator spoke's unpublishModel3d: flip a Model3D to Unpublished, skipping a
// deleted row so the review action can't resurrect it. The recordModActivity side-effect and the main-app
// userContentOverviewCache refresh stay with the caller.
export function unpublishModel3d(db: Kysely<DB>, { id }: { id: number; userId: number }) {
  return db
    .updateTable('Model3D')
    .set({ status: 'Unpublished' })
    .where('id', '=', id)
    .where('deletedAt', 'is', null)
    .execute();
}
