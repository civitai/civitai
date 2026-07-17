import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { keepUpdatedAt } from './infra/updated-at-plugin';

// -----------------------------------------------------------------------------
// deletePost — the DB delete cores of the source `deletePost`. Decomposed into
// per-statement db-first functions; `deletePost` runs them in one transaction.
// The collection removal, search-index / cache invalidation, and S3 deletion
// side effects are SKIPPED (they stay with the caller).
// -----------------------------------------------------------------------------

// The post's images eligible for deletion: all of them for a moderator, otherwise only the post owner's own.
export function getPostImagesForDelete(
  db: Kysely<DB>,
  input: { postId: number; isModerator?: boolean }
) {
  return db
    .selectFrom('Image as i')
    .innerJoin('Post as p', 'p.id', 'i.postId')
    .select(['i.id', 'i.url'])
    .where('i.postId', '=', input.postId)
    .$if(!input.isModerator, (qb) => qb.whereRef('i.userId', '=', 'p.userId'))
    .execute();
}

// Delete the given images, RETURNing id + url for downstream S3 cleanup. Guards the empty-array case.
export function deleteImagesByIds(db: Kysely<DB>, ids: number[]) {
  if (!ids.length) return Promise.resolve([]);
  return db.deleteFrom('Image').where('id', 'in', ids).returning(['id', 'url']).execute();
}

// Delete the post row, RETURNing id + nsfwLevel.
export function deletePostRecord(db: Kysely<DB>, id: number) {
  return db
    .deleteFrom('Post')
    .where('id', '=', id)
    .returning(['id', 'nsfwLevel'])
    .executeTakeFirst();
}

// Compose: delete a post and its (eligible) images atomically. Returns the deleted post plus the deleted
// images (the caller uses the latter for search-index / cache / S3 cleanup).
export function deletePost(db: Kysely<DB>, input: { id: number; isModerator?: boolean }) {
  return db.transaction().execute(async (trx) => {
    const images = await getPostImagesForDelete(trx, {
      postId: input.id,
      isModerator: input.isModerator,
    });
    const deletedImages = images.length
      ? await deleteImagesByIds(
          trx,
          images.map((i) => i.id)
        )
      : [];
    const post = await deletePostRecord(trx, input.id);
    return { post, deletedImages };
  });
}

// -----------------------------------------------------------------------------
// Post nsfwLevel recomputation.
// -----------------------------------------------------------------------------

// Recompute each post's nsfwLevel as the bit_or of its images' levels, writing only where it changed. Faithful
// port of the source raw CTE. Guards the empty-array case.
export async function updatePostNsfwLevels(db: Kysely<DB>, postIds: number[]) {
  if (!postIds.length) return;
  await sql`
    WITH level AS (
      SELECT DISTINCT ON (p.id) p.id, bit_or(i."nsfwLevel") "nsfwLevel"
      FROM "Post" p
      JOIN "Image" i ON i."postId" = p.id
      WHERE p.id IN (${sql.join(postIds)})
      GROUP BY p.id
    )
    UPDATE "Post" p
    SET "nsfwLevel" = level."nsfwLevel"
    FROM level
    WHERE level.id = p.id AND level."nsfwLevel" != p."nsfwLevel";
  `.execute(db);
}

// Recompute post nsfwLevels via the `update_post_nsfw_levels` stored procedure. Dedupes ids and guards the
// empty case (the source's `filter(isDefined)` is covered by the number[] input).
export async function updatePostNsfwLevel(db: Kysely<DB>, ids: number | number[]) {
  const arr = [...new Set(Array.isArray(ids) ? ids : [ids])];
  if (!arr.length) return;
  await sql`SELECT update_post_nsfw_levels(ARRAY[${sql.join(arr)}]::int[])`.execute(db);
}

// -----------------------------------------------------------------------------
// User-moderation post cores (from bulkUnpublish / removeAllContent).
// -----------------------------------------------------------------------------

// Unpublish the user's posts tied to the given versions: stamp `metadata` (unpublishedAt/By + prevPublishedAt)
// and clear `publishedAt`. Only touches already-published posts owned by the user. Raw `$executeRaw` in the
// source (no `@updatedAt` bump) — keepUpdatedAt preserves that.
export async function unpublishPostsForUser(
  db: Kysely<DB>,
  input: { userId: number; versionIds: number[]; unpublishedAt: string; unpublishedBy: number }
) {
  if (!input.versionIds.length) return [];
  return db
    .updateTable('Post')
    .set({
      metadata: sql`COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(
        'unpublishedAt', ${input.unpublishedAt}::text,
        'unpublishedBy', ${input.unpublishedBy}::int,
        'prevPublishedAt', "publishedAt"
      )`,
      publishedAt: null,
      updatedAt: keepUpdatedAt,
    })
    .where('publishedAt', 'is not', null)
    .where('userId', '=', input.userId)
    .where('modelVersionId', 'in', input.versionIds)
    .execute();
}

export function deletePostForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('Post').where('userId', '=', userId).execute();
}
