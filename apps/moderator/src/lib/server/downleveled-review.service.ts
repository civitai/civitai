import { getClickhouse } from './clickhouse';
import { dbRead } from './db';
import { takePage } from './keyset-page';
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

// `createdAt` is whole seconds and one second can hold thousands of rows, so the cursor carries the
// image id as a tie-break. A cursor on `createdAt` alone could never page past such a second.
const encodeCursor = (r: ChRow) => `${r.createdAt}|${r.imageId}`;

export function parseDownleveledCursor(cursor: string): { at: string; id: number } | undefined {
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|(\d{1,10})$/.exec(cursor);
  if (!match) return undefined;
  const [, at, rawId] = match;
  const id = Number(rawId);
  const iso = at.replace(' ', 'T');
  const date = new Date(`${iso}Z`);
  if (id > 0xffffffff || Number.isNaN(date.getTime())) return undefined;
  if (date.toISOString().slice(0, 19) !== iso) return undefined;
  // ClickHouse clamps a DateTime outside these years instead of rejecting it, serving a wrong page.
  const year = date.getUTCFullYear();
  if (year < 1970 || year > 2105) return undefined;
  return { at, id };
}

// originalLevel = the level before the KoNO downlevel.
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
  const after = cursor ? parseDownleveledCursor(cursor) : undefined;
  if (after) {
    conditions.push('(createdAt, imageId) < ({cursorAt:DateTime}, {cursorId:UInt32})');
    params.cursorAt = after.at;
    params.cursorId = after.id;
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
      ORDER BY createdAt DESC, imageId DESC
      LIMIT {lim:UInt32}
    `,
    query_params: params,
    format: 'JSONEachRow',
  });
  const { items: rows, nextCursor } = takePage(await resp.json<ChRow>(), limit, encodeCursor);
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
