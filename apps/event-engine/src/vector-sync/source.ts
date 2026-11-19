import type { Pool } from 'pg';
import { IMAGE_ROW_COLUMNS, type ImageRow } from './eligibility';

export type ImagePayload = {
  nsfwLevel: number;
  tagIds: number[];
  baseModels: string[];
  /** The model versions the image was made with. Its payload index is created by hand, not in `bootstrap`. */
  modelVersionIds: number[];
  type: string;
  userId: number;
  postId: number;
  sortAt: string;
};

export async function getImageRows(pg: Pool, ids: number[]): Promise<ImageRow[]> {
  if (!ids.length) return [];
  const { rows } = await pg.query<ImageRow>(
    `SELECT ${IMAGE_ROW_COLUMNS} FROM "Image" i WHERE i.id = ANY($1::int[])`,
    [ids]
  );
  return rows;
}

/** Every row with lo <= id < hi, newest first. Fetches all rows (not only eligible ones) so a page's cost is bounded by the id span, not by how sparse eligibility is. */
export async function getImageRowsInRange(pg: Pool, lo: number, hi: number): Promise<ImageRow[]> {
  const { rows } = await pg.query<ImageRow>(
    `SELECT ${IMAGE_ROW_COLUMNS} FROM "Image" i WHERE i.id >= $1 AND i.id < $2 ORDER BY i.id DESC`,
    [lo, hi]
  );
  return rows;
}

export async function getPayloads(pg: Pool, rows: ImageRow[]): Promise<Map<number, ImagePayload>> {
  const ids = rows.map((r) => r.id);
  const [tags, resources] = ids.length
    ? await Promise.all([
        pg.query<{ imageId: number; tagIds: number[] }>(
          `SELECT "imageId", array_agg("tagId" ORDER BY "tagId") AS "tagIds"
           FROM "TagsOnImageDetails" WHERE "imageId" = ANY($1::int[]) AND disabled = false
           GROUP BY "imageId"`,
          [ids]
        ),
        pg.query<{ imageId: number; baseModels: string[]; modelVersionIds: number[] }>(
          `SELECT ir."imageId", array_agg(DISTINCT mv."baseModel") AS "baseModels",
             array_agg(DISTINCT mv.id ORDER BY mv.id) AS "modelVersionIds"
           FROM "ImageResourceNew" ir JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
           WHERE ir."imageId" = ANY($1::int[])
           GROUP BY ir."imageId"`,
          [ids]
        ),
      ])
    : [{ rows: [] }, { rows: [] }];
  const tagMap = new Map(tags.rows.map((r) => [r.imageId, r.tagIds]));
  const resourceMap = new Map(resources.rows.map((r) => [r.imageId, r]));

  return new Map(
    rows.map((row) => [
      row.id,
      {
        nsfwLevel: row.nsfwLevel,
        tagIds: tagMap.get(row.id) ?? [],
        baseModels: resourceMap.get(row.id)?.baseModels ?? [],
        modelVersionIds: resourceMap.get(row.id)?.modelVersionIds ?? [],
        type: row.type,
        userId: row.userId,
        // Only eligible rows get a payload, and eligibility requires a post.
        postId: row.postId as number,
        sortAt: new Date(row.sortAt).toISOString(),
      },
    ])
  );
}
