import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { recordModActivity } from './mod-activity';
import { upsertTagsOnImageNew } from './tags-on-image.service';
import { NsfwLevel } from '@civitai/shared';
import type { MediaType } from '$lib/media/edge-url';

export type ImageTagReviewTag = {
  tagId: number;
  name: string;
  needsReview: boolean;
  upVotes: number;
  downVotes: number;
  nsfwLevel: number;
};

export type ImageTagReviewItem = {
  id: number;
  url: string;
  nsfwLevel: number;
  width: number | null;
  height: number | null;
  type: MediaType;
  username: string | null;
  tags: ImageTagReviewTag[];
};

// tagReview queue: images carrying a Moderation tag that's been flagged needsReview (the community voted
// to remove it) and isn't already disabled. Ported from image.service `getImageModerationReviewQueue`
// (tagReview branch). needsReview/disabled live in TagsOnImageNew.attributes as a bitmask — bit 9 =
// needsReview, bit 10 = disabled; TagsOnImageDetails / ImageTag are read-only views over that table.
export async function getImageTagReviewQueue({
  cursor,
  limit,
}: {
  cursor?: number;
  limit: number;
}): Promise<{ items: ImageTagReviewItem[]; nextCursor?: number }> {
  // The `>>9`/`>>10` predicates must be written EXACTLY as the partial indexes
  // `TagsOnImageNew_needsReview_idx` / `_disabled_idx` define them — including the `::integer` cast —
  // or the planner can't match them and seq-scans the (enormous) TagsOnImageNew instead. Do NOT join Tag
  // here to narrow to Moderation type: that forces a per-tag scan of TagsOnImageNew_tagId_idx over
  // millions of rows (55s+). needsReview is only ever set on Moderation tags anyway, and the tag fetch
  // below re-filters by type.
  const { rows: images } = await sql<Omit<ImageTagReviewItem, 'tags'>>`
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
    WHERE i."nsfwLevel" < ${NsfwLevel.Blocked}
    ORDER BY i.id DESC
    LIMIT ${limit + 1}
  `.execute(dbRead);

  let nextCursor: number | undefined;
  if (limit && images.length > limit) nextCursor = images.pop()?.id;

  const ids = images.map((i) => i.id);
  const tagsByImage = new Map<number, ImageTagReviewTag[]>();
  if (ids.length) {
    // Read tags from TagsOnImageDetails (a thin 1:1 view over TagsOnImageNew — predicate pushes to the
    // PK index) + a grouped vote count off the TagsOnImageVote imageId hash index. ~3ms. The `ImageTag`
    // view would give the same shape but does a CROSS JOIN LATERAL vote aggregation per tag over a UNION
    // (~80ms and scales with vote volume — and these are the most-voted tags) — the main app only ever
    // reads it through the Redis imageTagsCache, never inline.
    const { rows: tags } = await sql<ImageTagReviewTag & { imageId: number }>`
      SELECT d."imageId", d."tagId", t.name, t."nsfwLevel", d."needsReview",
             COALESCE(v.up, 0)::int AS "upVotes", COALESCE(v.down, 0)::int AS "downVotes"
      FROM "TagsOnImageDetails" d
      JOIN "Tag" t ON t.id = d."tagId" AND t.type = 'Moderation'
      LEFT JOIN (
        SELECT "imageId", "tagId",
               SUM(CASE WHEN vote > 0 THEN 1 ELSE 0 END) up,
               SUM(CASE WHEN vote < 0 THEN 1 ELSE 0 END) down
        FROM "TagsOnImageVote"
        WHERE "imageId" IN (${sql.join(ids)})
        GROUP BY "imageId", "tagId"
      ) v ON v."imageId" = d."imageId" AND v."tagId" = d."tagId"
      WHERE d."imageId" IN (${sql.join(ids)}) AND d.disabled = false
      ORDER BY d."imageId", "downVotes" DESC
    `.execute(dbRead);
    for (const { imageId, ...tag } of tags) {
      const arr = tagsByImage.get(imageId) ?? [];
      arr.push(tag);
      tagsByImage.set(imageId, arr);
    }
  }

  return {
    items: images.map((i) => ({ ...i, tags: tagsByImage.get(i.id) ?? [] })),
    nextCursor,
  };
}

// A moderator's decision on flagged tags is authoritative, so we write the outcome directly rather than
// routing it through the weighted-vote tally + apply-voted-tags cron the main app uses for community
// votes: approve removal → disabled=true; keep → disabled=false. Either way needsReview clears. source /
// confidence are omitted so `upsert_tag_on_image` preserves them; automated is forced false (manual
// decision). The shared write + side effects (tag-rule expansion, cache busts, nsfwLevel recompute,
// search-index enqueue) live in `upsertTagsOnImageNew` — the Kysely port of the main-app helper.
export async function moderateImageTags({
  imageId,
  tagIds,
  disable,
  userId,
}: {
  imageId: number;
  tagIds?: number[];
  disable: boolean;
  userId: number;
}): Promise<{ tagIds: number[] }> {
  let targets = tagIds ?? [];
  if (!targets.length) {
    const { rows } = await sql<{ tagId: number }>`
      SELECT d."tagId"
      FROM "TagsOnImageDetails" d
      JOIN "Tag" t ON t.id = d."tagId" AND t.type = 'Moderation'
      WHERE d."imageId" = ${imageId} AND d."needsReview" = true
    `.execute(dbRead);
    targets = rows.map((r) => r.tagId);
  }
  if (!targets.length) return { tagIds: [] };

  // automated:false marks it a manual decision; source/confidence omitted so the upsert preserves them.
  // upsertTagsOnImageNew handles the shared side effects (cache busts, nsfwLevel recompute, search-index).
  await upsertTagsOnImageNew(
    targets.map((tagId) => ({
      imageId,
      tagId,
      automated: false,
      disabled: disable,
      needsReview: false,
    }))
  );

  await recordModActivity({
    userId,
    entityType: 'image',
    entityId: imageId,
    activity: 'moderateTag',
  });

  return { tagIds: targets };
}
