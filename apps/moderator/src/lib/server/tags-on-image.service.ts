import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import type { TagSource } from '@civitai/db-schema/enums';
import { dbRead, dbWrite } from './db';
import { getRedis } from './redis';
import { syncSearchIndex } from './search-index';
import { bustImageTagCaches } from './cache';

// A single (imageId, tagId) tag row plus the attribute bits to set. Unset fields are left NULL and the
// `upsert_tag_on_image` DB function preserves the existing value on conflict — so a moderation flip can
// pass just `{ imageId, tagId, disabled, needsReview }` without clobbering source/confidence.
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

// Replace/Append tag relationships (`TagsOnTags`). The main app caches them at `system:tag-rules`; we
// read that same key and fall back to the source table on a miss (without repopulating — the main app
// owns the cache's TTL/format).
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

// Port of the main app's applyTagRules: a Replace rule rewrites the target tag to its `fromId`; an
// Append rule keeps it and adds `fromId` (Computed, confidence 70). Deduped by (imageId, tagId), keeping
// the first occurrence. Only fires when a supplied tag is a rule's `toId`.
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

// Kysely port of main-app `upsertTagsOnImageNew`: expand through tag rules, upsert each row via the
// shared `upsert_tag_on_image` DB function, then run the shared side effects — bust the image-tag
// caches, recompute nsfwLevel for the touched images, and enqueue a search-index update. Bind params are
// cast (::int / ::"TagSource" / …) so the function's overload resolves; NULLs preserve existing bits.
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
  await bustImageTagCaches(imageIds);
  await sql`SELECT update_nsfw_levels_new(ARRAY[${sql.join(
    imageIds.map((id) => sql`${id}::int`)
  )}])`.execute(dbWrite);
  for (const id of imageIds)
    syncSearchIndex({ entityType: 'image', entityId: id, action: 'update' });
}
