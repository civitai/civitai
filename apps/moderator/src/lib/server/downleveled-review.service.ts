import { getClickhouse } from './clickhouse';
import { dbRead } from './db';
import type { MediaType } from '$lib/media/edge-url';

export type DownleveledImageItem = {
  id: number;
  url: string;
  nsfwLevel: number; // current (downleveled) level
  originalLevel: number; // level before the KoNO game downleveled it
  width: number | null;
  height: number | null;
  type: MediaType;
};

type ChRow = { imageId: number; originalLevel: number; createdAt: string };

// Queue of images the Knights of New Order game DOWNLEVELED (reduced the rating on). Sourced from
// ClickHouse `knights_new_order_downleveled` (originalLevel = the level before the downlevel), enriched
// with the current image row from Postgres. A moderator restores/corrects the level via updateImageNsfwLevel.
export async function getDownleveledImages({
  cursor,
  limit,
  originalLevel,
}: {
  cursor?: string;
  limit: number;
  originalLevel?: number;
}): Promise<{ items: DownleveledImageItem[]; nextCursor?: string }> {
  const conditions: string[] = [];
  const params: Record<string, unknown> = { lim: limit + 1 };
  if (cursor) {
    conditions.push('createdAt <= {cursor:String}');
    params.cursor = cursor;
  }
  if (originalLevel !== undefined) {
    conditions.push('originalLevel = {originalLevel:UInt32}');
    params.originalLevel = originalLevel;
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const resp = await getClickhouse().query({
    query: `
      SELECT imageId, originalLevel, createdAt
      FROM knights_new_order_downleveled
      ${where}
      ORDER BY createdAt DESC
      LIMIT {lim:UInt32}
    `,
    query_params: params,
    format: 'JSONEachRow',
  });
  const rows = await resp.json<ChRow[]>();

  let nextCursor: string | undefined;
  if (limit && rows.length > limit) nextCursor = rows.pop()?.createdAt;
  if (rows.length === 0) return { items: [], nextCursor };

  const imageIds = rows.map((r) => Number(r.imageId));
  const images = await dbRead
    .selectFrom('Image')
    .select(['id', 'url', 'nsfwLevel', 'type', 'width', 'height'])
    .where('id', 'in', imageIds)
    .execute();
  const imageMap = new Map(images.map((img) => [img.id, img]));

  const items = rows
    .map((r) => {
      const img = imageMap.get(Number(r.imageId));
      if (!img) return null;
      return {
        id: img.id,
        url: img.url,
        nsfwLevel: img.nsfwLevel,
        originalLevel: Number(r.originalLevel),
        width: img.width,
        height: img.height,
        type: img.type as MediaType,
      };
    })
    .filter((x): x is DownleveledImageItem => x !== null);

  return { items, nextCursor };
}
