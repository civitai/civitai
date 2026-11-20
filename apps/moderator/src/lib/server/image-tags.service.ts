import { sql } from '@civitai/db/kysely';
import { modReviewEligibleImage, removalLowersLevel } from '@civitai/db/knights';
import type { ImageTagModerateResult } from '@civitai/moderation';
import { dbRead, dbWrite } from './db';
import { takePage } from './keyset-page';
import { recordModActivity } from './mod-activity';
import {
  afterTagWrite,
  upsertTagsOnImageNew,
  withTagRules,
  writeTagRows,
} from './tags-on-image.service';
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

// needsReview/disabled live in TagsOnImageNew.attributes as a bitmask: bit 9 = needsReview, bit 10 = disabled.
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
  const { rows: fetched } = await sql<Omit<ImageTagReviewItem, 'tags'>>`
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

  const { items: images, nextCursor } = takePage(fetched, limit, (i) => i.id);

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

export type GuardedTagOutcome = ImageTagModerateResult;

/**
 * A moderator's Keep/Remove on an image's flagged tags (all of them when `tagIds` is empty), recorded as `activity`.
 *
 * `onlyIfFlagged` is the guarded mode Knights' tag write-back uses: one tag, decided by a player consensus, and written
 * only while that tag is still flagged and the image may still be judged by players. It locks the tag row first; a
 * moderator's own write takes the same lock, so a consensus never overwrites a moderator's ruling. A removal settled on
 * the minimum votes (`settledAtMinimum`) that would now lower the image's rating is refused, since it needs the stricter
 * rule. Every refusal changes nothing and leaves the tag in the queue.
 */
export async function moderateImageTags({
  imageId,
  tagIds,
  disable,
  userId,
  activity = 'moderateTag',
  onlyIfFlagged = false,
  settledAtMinimum = false,
}: {
  imageId: number;
  tagIds?: number[];
  disable: boolean;
  userId: number;
  activity?: string;
  onlyIfFlagged?: boolean;
  settledAtMinimum?: boolean;
}): Promise<{ tagIds: number[] } & Partial<GuardedTagOutcome>> {
  if (onlyIfFlagged) {
    const [tagId] = tagIds ?? [];
    if (tagIds?.length !== 1) throw new Error('A guarded tag write takes exactly one tag.');
    const result = await writeFlaggedTag({ imageId, tagId, disable, settledAtMinimum });
    if (result.outcome !== 'applied') return { tagIds: [], ...result };
    await recordModActivity({ userId, entityType: 'image', entityId: imageId, activity });
    return { tagIds: [tagId], ...result };
  }

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

  // source/confidence omitted so upsert_tag_on_image preserves them; automated:false = manual decision.
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
    activity,
  });

  return { tagIds: targets };
}

async function writeFlaggedTag({
  imageId,
  tagId,
  disable,
  settledAtMinimum,
}: {
  imageId: number;
  tagId: number;
  disable: boolean;
  settledAtMinimum: boolean;
}): Promise<GuardedTagOutcome> {
  const items = await withTagRules([
    { imageId, tagId, automated: false, disabled: disable, needsReview: false },
  ]);
  const outcome = await dbWrite.transaction().execute(async (trx): Promise<GuardedTagOutcome> => {
    const row = await trx
      .selectFrom('TagsOnImageNew')
      .select('attributes')
      .where('imageId', '=', imageId)
      .where('tagId', '=', tagId)
      .forUpdate()
      .executeTakeFirst();
    const image = await trx
      .selectFrom('Image as img')
      .leftJoin('Post as p', 'p.id', 'img.postId')
      .select((eb) => ['img.id', modReviewEligibleImage(eb).as('eligible')])
      .where('img.id', '=', imageId)
      .executeTakeFirst();
    if (!image) return { outcome: 'missing' };
    if (!row || !isFlagged(row.attributes)) return { outcome: 'already-ruled' };
    if (image.eligible !== true) return { outcome: 'ineligible', reason: 'image' };
    const tag = await trx
      .selectFrom('Tag')
      .select('nsfwLevel')
      .where('id', '=', tagId)
      .executeTakeFirst();
    if (!tag || tag.nsfwLevel >= NsfwLevel.Blocked) return { outcome: 'ineligible', reason: 'tag' };
    if (disable && settledAtMinimum && (await removalLowersLevel(trx, imageId, tagId)))
      return { outcome: 'ineligible', reason: 'lowers-level' };
    await writeTagRows(trx, items);
    return { outcome: 'applied' };
  });
  if (outcome.outcome === 'applied') await afterTagWrite(items);
  return outcome;
}

/** In the review queue: needsReview (bit 9) set, disabled (bit 10) clear. */
const isFlagged = (attributes: number) =>
  ((attributes >> 9) & 1) === 1 && ((attributes >> 10) & 1) === 0;
