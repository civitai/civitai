import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';

export type PostCoverRow = {
  postId: number;
  id: number;
  url: string;
  type: string;
  nsfwLevel: number;
  minor: boolean;
  acceptableMinor: boolean;
  /** Images on the post, counted up to `countCap` when one is given. */
  total: number;
};

type Options = {
  limit: number;
  /** Only these `Image.type` values count, for both the images and the total. */
  mediaTypes?: string[];
  /** Stop counting here, so a post with thousands of images costs a bounded scan. */
  countCap?: number;
};

/**
 * Each post's first `limit` images in the author's order (`index` ascending, nulls last, then id) with the
 * post's total, in one read for all posts. Rows come ordered by post, then that order. A post with no
 * matching image yields no row.
 */
export async function postCoverRows(
  postIds: number[],
  { limit, mediaTypes, countCap }: Options
): Promise<PostCoverRow[]> {
  if (!postIds.length) return [];
  const mediaFilter = mediaTypes?.length
    ? sql`and i.type::text in (${sql.join(mediaTypes)})`
    : sql``;
  const cap = countCap === undefined ? sql`` : sql`limit ${sql.raw(String(countCap))}`;
  const { rows } = await sql<Omit<PostCoverRow, 'total'> & { total: number | string }>`
    select p.id as "postId", c.id, c.url, c."nsfwLevel", c.type::text as type, c.minor, c."acceptableMinor", n.total
    from "Post" p
    cross join lateral (
      select i.id, i.url, i."nsfwLevel", i.type, i.minor, i."acceptableMinor", i.index
      from "Image" i
      where i."postId" = p.id ${mediaFilter}
      order by i.index asc nulls last, i.id asc
      limit ${sql.raw(String(limit))}
    ) c
    cross join lateral (
      select count(*)::int as total
      from (
        select 1 from "Image" i
        where i."postId" = p.id ${mediaFilter}
        ${cap}
      ) capped
    ) n
    where p.id in (${sql.join(postIds)})
    order by p.id, c.index asc nulls last, c.id asc`.execute(dbRead);
  return rows.map((r) => ({ ...r, total: Number(r.total) }));
}
