import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { NsfwLevel } from '@civitai/shared';
import type { MediaType } from '$lib/media/edge-url';

export type ImageRatingItem = {
  id: number;
  votes: Record<string, number>; // jsonb keys are strings ("1","2","4","8","16")
  total: number; // summed request weight (owner requests weigh 3)
  requests: number; // distinct request rows (owner + community)
  url: string;
  nsfwLevel: number;
  nsfwLevelLocked: boolean;
  width: number | null;
  height: number | null;
  type: MediaType;
  createdAt: Date;
};

// Community-rating review queue: images whose pending ImageRatingRequest votes disagree enough with the
// current level (total weight >= 3) to warrant a moderator decision. Ported from image.service. Votable
// tags are intentionally omitted here (that UI belongs with the image-tags migration).
export async function getImageRatingRequests({
  cursor,
  limit,
}: {
  cursor?: number;
  limit: number;
}): Promise<{ items: ImageRatingItem[]; nextCursor?: number }> {
  const { rows } = await sql<ImageRatingItem>`
    WITH image_rating_requests AS (
      SELECT
        "imageId",
        COALESCE(SUM(weight), 0) total,
        count(*)::int requests,
        MIN("createdAt") "createdAt",
        jsonb_build_object(
          1, COALESCE(SUM(weight) FILTER (where "nsfwLevel" = 1), 0),
          2, COALESCE(SUM(weight) FILTER (where "nsfwLevel" = 2), 0),
          4, COALESCE(SUM(weight) FILTER (where "nsfwLevel" = 4), 0),
          8, COALESCE(SUM(weight) FILTER (where "nsfwLevel" = 8), 0),
          16, COALESCE(SUM(weight) FILTER (where "nsfwLevel" = 16), 0)
        ) "votes"
      FROM "ImageRatingRequest"
      WHERE status = 'Pending'
      GROUP BY "imageId"
    )
    SELECT
      i.id,
      irr.votes,
      irr.total::int,
      irr.requests,
      i.url,
      i."nsfwLevel",
      i."nsfwLevelLocked",
      i.width,
      i.height,
      i.type,
      i."createdAt"
    FROM image_rating_requests irr
    JOIN "Image" i ON i.id = irr."imageId"
    WHERE irr.total >= 3
      AND i."blockedFor" IS NULL
      AND i."nsfwLevelLocked" = FALSE
      AND i.ingestion != 'PendingManualAssignment'::"ImageIngestionStatus"
      AND i."nsfwLevel" < ${NsfwLevel.Blocked}
      ${cursor ? sql`AND i."id" >= ${cursor}` : sql``}
    ORDER BY i."id" ASC
    LIMIT ${limit + 1}
  `.execute(dbRead);

  let nextCursor: number | undefined;
  if (limit && rows.length > limit) nextCursor = rows.pop()?.id;

  return { items: rows, nextCursor };
}

// Sidebar-badge count for the rating-review queue — the same predicate as getImageRatingRequests, sans
// paging. Streamed with the other sidebar counts, so its cost stays off render.
export async function getImageRatingReviewCount(): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    WITH image_rating_requests AS (
      SELECT "imageId", COALESCE(SUM(weight), 0) total
      FROM "ImageRatingRequest"
      WHERE status = 'Pending'
      GROUP BY "imageId"
    )
    SELECT count(*)::int count
    FROM image_rating_requests irr
    JOIN "Image" i ON i.id = irr."imageId"
    WHERE irr.total >= 3
      AND i."blockedFor" IS NULL
      AND i."nsfwLevelLocked" = FALSE
      AND i.ingestion != 'PendingManualAssignment'::"ImageIngestionStatus"
      AND i."nsfwLevel" < ${NsfwLevel.Blocked}
  `.execute(dbRead);
  return rows[0]?.count ?? 0;
}
