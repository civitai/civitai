import { sql, type Kysely } from 'kysely';
import type { Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Image.type unwrapped from its Generated<> column wrapper, so this module needs no moderator-app type import.
type ImageMediaType = Selectable<DB['Image']>['type'];

// NsfwLevel.Blocked — the browsing-level bit for blocked content. Inlined here (was NsfwLevel.Blocked in the
// moderator source) so the module carries no shared-enum runtime dependency; interpolated as a bound param.
const NSFW_LEVEL_BLOCKED = 32;

export type ImageTagReviewTag = {
  tagId: number;
  name: string;
  needsReview: boolean;
  upVotes: number;
  downVotes: number;
  nsfwLevel: number;
};

export type ImageTagReviewImage = {
  id: number;
  url: string;
  nsfwLevel: number;
  width: number | null;
  height: number | null;
  type: ImageMediaType;
  username: string | null;
};

export type ImageTagReviewItem = ImageTagReviewImage & { tags: ImageTagReviewTag[] };

// The candidate images for the tagReview queue: images carrying a Moderation tag flagged needsReview (the
// community voted to remove it) and not already disabled. needsReview/disabled live in
// TagsOnImageNew.attributes as a bitmask — bit 9 = needsReview, bit 10 = disabled.
//
// The `>>9`/`>>10` predicates must be written EXACTLY as the partial indexes
// `TagsOnImageNew_needsReview_idx` / `_disabled_idx` define them — including the `::integer` cast — or the
// planner can't match them and seq-scans the (enormous) TagsOnImageNew instead. Do NOT join Tag here to
// narrow to Moderation type: that forces a per-tag scan of TagsOnImageNew_tagId_idx over millions of rows
// (55s+). needsReview is only ever set on Moderation tags anyway, and getImageTagReviewTags re-filters by
// type. Fetches limit+1 so the caller can derive nextCursor.
export async function getImageTagReviewImages(
  db: Kysely<DB>,
  {
    cursor,
    limit,
  }: {
    cursor?: number;
    limit: number;
  }
): Promise<ImageTagReviewImage[]> {
  const { rows } = await sql<ImageTagReviewImage>`
    WITH reviewable AS MATERIALIZED (
      SELECT DISTINCT "imageId"
      FROM "TagsOnImageNew"
      WHERE (((attributes >> 9)::integer & 1) = 1)
        AND (((attributes >> 10)::integer & 1) <> 1)
        ${cursor ? sql`AND "imageId" < ${cursor}` : sql``}
      ORDER BY "imageId" DESC
    )
    SELECT i.id, i.url, i."nsfwLevel", i.width, i.height, i.type, u.username
    FROM reviewable r
    JOIN "Image" i ON i.id = r."imageId"
    JOIN "User" u ON u.id = i."userId"
    WHERE i."nsfwLevel" < ${NSFW_LEVEL_BLOCKED}
    ORDER BY i.id DESC
    LIMIT ${limit + 1}
  `.execute(db);
  return rows;
}

// The flagged Moderation tags for a set of images, with up/down vote tallies. Reads from TagsOnImageDetails
// (a thin 1:1 view over TagsOnImageNew — predicate pushes to the PK index) + a grouped vote count off the
// TagsOnImageVote imageId hash index (~3ms). The `ImageTag` view would give the same shape but does a CROSS
// JOIN LATERAL vote aggregation per tag over a UNION (~80ms and scales with vote volume). Rows carry
// imageId so the caller can group them per image.
export async function getImageTagReviewTags(
  db: Kysely<DB>,
  imageIds: number[]
): Promise<Array<ImageTagReviewTag & { imageId: number }>> {
  if (!imageIds.length) return [];
  const { rows } = await sql<ImageTagReviewTag & { imageId: number }>`
    SELECT d."imageId", d."tagId", t.name, t."nsfwLevel", d."needsReview",
           COALESCE(v.up, 0)::int AS "upVotes", COALESCE(v.down, 0)::int AS "downVotes"
    FROM "TagsOnImageDetails" d
    JOIN "Tag" t ON t.id = d."tagId" AND t.type = 'Moderation'
    LEFT JOIN (
      SELECT "imageId", "tagId",
             SUM(CASE WHEN vote > 0 THEN 1 ELSE 0 END) up,
             SUM(CASE WHEN vote < 0 THEN 1 ELSE 0 END) down
      FROM "TagsOnImageVote"
      WHERE "imageId" IN (${sql.join(imageIds)})
      GROUP BY "imageId", "tagId"
    ) v ON v."imageId" = d."imageId" AND v."tagId" = d."tagId"
    WHERE d."imageId" IN (${sql.join(imageIds)}) AND d.disabled = false
    ORDER BY d."imageId", "downVotes" DESC
  `.execute(db);
  return rows;
}

// tagReview queue: images with community-flagged Moderation tags awaiting a moderator decision, each with
// its flagged tags + vote tallies. Composes the two pure queries above (no side effects). Ported from
// moderator image-tags.service `getImageTagReviewQueue`.
export async function getImageTagReviewQueue(
  db: Kysely<DB>,
  {
    cursor,
    limit,
  }: {
    cursor?: number;
    limit: number;
  }
): Promise<{ items: ImageTagReviewItem[]; nextCursor?: number }> {
  const images = await getImageTagReviewImages(db, { cursor, limit });

  let nextCursor: number | undefined;
  if (limit && images.length > limit) nextCursor = images.pop()?.id;

  const ids = images.map((i) => i.id);
  const tagsByImage = new Map<number, ImageTagReviewTag[]>();
  const tags = await getImageTagReviewTags(db, ids);
  for (const { imageId, ...tag } of tags) {
    const arr = tagsByImage.get(imageId) ?? [];
    arr.push(tag);
    tagsByImage.set(imageId, arr);
  }

  return {
    items: images.map((i) => ({ ...i, tags: tagsByImage.get(i.id) ?? [] })),
    nextCursor,
  };
}

// The target-tag lookup from moderator `moderateImageTags`: when a moderator acts on an image without
// naming specific tags, resolve the image's flagged Moderation tags (needsReview = true) as the default
// target set. The actual write is `upsertTagsOnImageNew` — a SEPARATE tags-on-image domain — NOT ported
// here. Returns the tag ids.
export async function getImageTagsNeedingReview(
  db: Kysely<DB>,
  {
    imageId,
  }: {
    imageId: number;
  }
): Promise<number[]> {
  const { rows } = await sql<{ tagId: number }>`
    SELECT d."tagId"
    FROM "TagsOnImageDetails" d
    JOIN "Tag" t ON t.id = d."tagId" AND t.type = 'Moderation'
    WHERE d."imageId" = ${imageId} AND d."needsReview" = true
  `.execute(db);
  return rows.map((r) => r.tagId);
}
