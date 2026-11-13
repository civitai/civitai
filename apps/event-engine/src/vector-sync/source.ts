import type { Pool } from 'pg';
import { IMAGE_ROW_COLUMNS, type ImageRow } from './eligibility';

export type ImagePayload = {
  nsfwLevel: number;
  tagIds: number[];
  baseModels: string[];
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
  const [tags, baseModels] = ids.length
    ? await Promise.all([
        pg.query<{ imageId: number; tagIds: number[] }>(
          `SELECT "imageId", array_agg("tagId" ORDER BY "tagId") AS "tagIds"
           FROM "TagsOnImageDetails" WHERE "imageId" = ANY($1::int[]) AND disabled = false
           GROUP BY "imageId"`,
          [ids]
        ),
        pg.query<{ imageId: number; baseModels: string[] }>(
          `SELECT ir."imageId", array_agg(DISTINCT mv."baseModel") AS "baseModels"
           FROM "ImageResourceNew" ir JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
           WHERE ir."imageId" = ANY($1::int[])
           GROUP BY ir."imageId"`,
          [ids]
        ),
      ])
    : [{ rows: [] }, { rows: [] }];
  const tagMap = new Map(tags.rows.map((r) => [r.imageId, r.tagIds]));
  const baseModelMap = new Map(baseModels.rows.map((r) => [r.imageId, r.baseModels]));

  return new Map(
    rows.map((row) => [
      row.id,
      {
        nsfwLevel: row.nsfwLevel,
        tagIds: tagMap.get(row.id) ?? [],
        baseModels: baseModelMap.get(row.id) ?? [],
        type: row.type,
        userId: row.userId,
        // Only eligible rows get a payload, and eligibility requires a post.
        postId: row.postId as number,
        sortAt: new Date(row.sortAt).toISOString(),
      },
    ])
  );
}
