import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import type { TagSource } from '@civitai/db-schema/enums';
import { NsfwLevel } from '@civitai/shared';
import { dbRead, dbWrite } from './db';
import { getRedis } from './redis';
import { syncSearchIndexBulk } from './search-index';
import { bustImageTagCaches } from './cache';
import { invalidateThumbnails } from './thumbnail-cache';

// Unset fields stay NULL; upsert_tag_on_image preserves the existing value on conflict — so a flip can pass
// just { imageId, tagId, disabled, needsReview } without clobbering source/confidence.
export type TagOnImageArgs = {
  imageId: number;
  tagId: number;
  source?: TagSource;
  confidence?: number;
  automated?: boolean;
  disabled?: boolean;
  needsReview?: boolean;
};

type TagRule = { fromId: number; toId: number; type: string };

// Reads the main app's system:tag-rules cache; falls back to the table on a miss WITHOUT repopulating (the
// main app owns the cache).
async function getTagRules(): Promise<TagRule[]> {
  try {
    const cached = await getRedis().get(REDIS_KEYS.SYSTEM.TAG_RULES);
    if (cached) return JSON.parse(cached) as TagRule[];
  } catch {
    // cache miss / unexpected value — fall back to the source table
  }
  const rows = await dbRead
    .selectFrom('TagsOnTags')
    .select(['fromTagId as fromId', 'toTagId as toId', 'type'])
    .where('type', 'in', ['Replace', 'Append'])
    .execute();
  return rows.map((r) => ({ fromId: r.fromId, toId: r.toId, type: String(r.type) }));
}

function applyTagRules(args: TagOnImageArgs[], rules: TagRule[]): TagOnImageArgs[] {
  let applied = [...args];
  for (const rule of rules) {
    const next: TagOnImageArgs[] = [];
    for (const tag of applied) {
      if (tag.tagId === rule.toId) {
        if (rule.type === 'Replace') {
          next.push({ ...tag, tagId: rule.fromId });
        } else {
          next.push(tag);
          next.push({ ...tag, tagId: rule.fromId, confidence: 70, source: 'Computed' });
        }
      } else {
        next.push(tag);
      }
    }
    applied = next;
  }
  const seen = new Map<string, TagOnImageArgs>();
  for (const t of applied) {
    const key = `${t.imageId}-${t.tagId}`;
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()];
}

// Bind params are cast (::int / ::"TagSource" / …) so upsert_tag_on_image's overload resolves; NULLs
// preserve existing bits.
export async function upsertTagsOnImageNew(args: TagOnImageArgs[]): Promise<void> {
  if (!args.length) return;
  const items = applyTagRules(args, await getTagRules());

  const values = sql.join(
    items.map(
      (t) =>
        sql`(${t.imageId}::int, ${t.tagId}::int, ${t.source ?? null}::"TagSource", ${
          t.confidence ?? null
        }::integer, ${t.automated ?? null}::boolean, ${t.disabled ?? null}::boolean, ${
          t.needsReview ?? null
        }::boolean)`
    )
  );
  await sql`
    SELECT upsert_tag_on_image(
      t."imageId", t."tagId", t."source", t."confidence", t."automated", t."disabled", t."needsReview"
    )
    FROM (VALUES ${values}) AS t("imageId", "tagId", "source", "confidence", "automated", "disabled", "needsReview")
  `.execute(dbWrite);

  const imageIds = [...new Set(items.map((x) => x.imageId))];
  // Bust after the recompute (busting first lets a reader refill the thumbnail entry with the old
  // level), and even when it throws, since the tag rows are already written.
  try {
    await sql`SELECT update_nsfw_levels_new(ARRAY[${sql.join(
      imageIds.map((id) => sql`${id}::int`)
    )}])`.execute(dbWrite);
  } finally {
    await bustImageTagCaches(imageIds);
    await invalidateThumbnails(imageIds);
  }
  await queueBlockedTagReviews(items);
  void syncSearchIndexBulk({ entityType: 'image', entityIds: imageIds, action: 'update' });
}

// Mirrors queueBlockedTagReviews in the main app's tagsOnImageNew.service: update_nsfw_levels_new raises an
// image to Blocked but never queues it, so without this a blocked-level tag would hide it with no review.
async function queueBlockedTagReviews(items: TagOnImageArgs[]) {
  const written = sql.join(items.map((t) => sql`(${t.imageId}::int, ${t.tagId}::int)`));
  await sql`
    WITH written AS (
      SELECT DISTINCT w."imageId", w."tagId"
      FROM (VALUES ${written}) AS w("imageId", "tagId")
      JOIN "Tag" t ON t.id = w."tagId" AND t."nsfwLevel" = ${NsfwLevel.Blocked}
      JOIN "TagsOnImageDetails" toi
        ON toi."imageId" = w."imageId" AND toi."tagId" = w."tagId" AND NOT toi.disabled
    ), flagged AS (
      UPDATE "Image" i SET "needsReview" = 'tag'
      WHERE i.id IN (SELECT "imageId" FROM written)
        AND i."nsfwLevel" = ${NsfwLevel.Blocked}
        AND i."needsReview" IS NULL
        AND i.ingestion = 'Scanned'
        AND i."blockedFor" IS NULL
        AND NOT i."nsfwLevelLocked"
      RETURNING i.id
    )
    INSERT INTO "ImageTagForReview" ("imageId", "tagId")
    SELECT w."imageId", w."tagId" FROM written w JOIN flagged f ON f.id = w."imageId"
    ON CONFLICT DO NOTHING
  `.execute(dbWrite);
}
