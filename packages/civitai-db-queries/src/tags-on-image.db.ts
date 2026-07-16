import { sql, type Kysely } from 'kysely';
import type { Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// The `TagSource` enum, derived from the schema so this module needs no separate enum import.
type TagSourceValue = Selectable<DB['TagsOnImageDetails']>['source'];

// A single (imageId, tagId) tag row plus the attribute bits to set. Unset fields are left NULL and the
// `upsert_tag_on_image` DB function preserves the existing value on conflict — so a moderation flip can
// pass just `{ imageId, tagId, disabled, needsReview }` without clobbering source/confidence.
export type TagOnImageArgs = {
  imageId: number;
  tagId: number;
  source?: TagSourceValue;
  confidence?: number;
  automated?: boolean;
  disabled?: boolean;
  needsReview?: boolean;
};

export type TagRule = { fromId: number; toId: number; type: string };

// Tag relationship rules (`TagsOnTags`) of kind Replace/Append. The main app caches these at
// `system:tag-rules`; this is only the source-table fallback for a cache miss (the redis-first read and its
// repopulation stay with the caller — the main app owns the cache's TTL/format).
export async function getTagRules(db: Kysely<DB>): Promise<TagRule[]> {
  const rows = await db
    .selectFrom('TagsOnTags')
    .select(['fromTagId as fromId', 'toTagId as toId', 'type'])
    .where('type', 'in', ['Replace', 'Append'])
    .execute();
  return rows.map((r) => ({ fromId: r.fromId, toId: r.toId, type: String(r.type) }));
}

// DB write core of the main-app `upsertTagsOnImageNew`: upsert each supplied row via the shared
// `upsert_tag_on_image` DB function through a raw VALUES list, then recompute nsfwLevel for the touched
// images via `update_nsfw_levels_new`. Bind params are cast (::int / ::"TagSource" / …) so the function's
// overload resolves; NULLs preserve existing bits. Tag-rule expansion and the cache/search side effects stay
// with the caller.
export async function upsertTagsOnImageNew(db: Kysely<DB>, args: TagOnImageArgs[]): Promise<void> {
  if (!args.length) return;

  const values = sql.join(
    args.map(
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
  `.execute(db);

  const imageIds = [...new Set(args.map((x) => x.imageId))];
  await sql`SELECT update_nsfw_levels_new(ARRAY[${sql.join(
    imageIds.map((id) => sql`${id}::int`)
  )}])`.execute(db);
}
