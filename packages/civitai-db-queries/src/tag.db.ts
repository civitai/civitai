import { type Kysely, type Selectable, type Updateable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// `target` is a Postgres enum ARRAY (TagTarget[]); `nsfw` is a scalar enum (NsfwLevel).
type TagTargetValue = Selectable<DB['Tag']>['target'][number];
type NsfwLevelValue = Selectable<DB['Tag']>['nsfw'];

export function getTagById(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('Tag')
    .select(['id', 'name', 'target', 'nsfw', 'nsfwLevel', 'createdAt', 'updatedAt'])
    .where('id', '=', id)
    .executeTakeFirst();
}

export function createTag(
  db: Kysely<DB>,
  input: { name: string; target: TagTargetValue[]; nsfw?: NsfwLevelValue }
) {
  return db
    .insertInto('Tag')
    .values({
      name: input.name,
      target: input.target,
      ...(input.nsfw !== undefined ? { nsfw: input.nsfw } : {}),
      updatedAt: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// connectOrCreate Tags by citext-unique name, returning their ids (batched). See README → Tag links.
export async function upsertTagsByName(
  db: Kysely<DB>,
  names: string[],
  target: TagTargetValue[]
): Promise<number[]> {
  if (!names.length) return [];
  await db
    .insertInto('Tag')
    .values(names.map((name) => ({ name, target, updatedAt: new Date() })))
    .onConflict((oc) => oc.column('name').doNothing())
    .execute();
  const rows = await db.selectFrom('Tag').select('id').where('name', 'in', names).execute();
  return rows.map((r) => r.id);
}

export function updateTag(db: Kysely<DB>, input: Updateable<DB['Tag']> & { id: number }) {
  const { id, ...data } = input;
  return db
    .updateTable('Tag')
    .set({ ...data })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

export function deleteTag(db: Kysely<DB>, id: number) {
  return db.deleteFrom('Tag').where('id', '=', id).execute();
}

// --- Votable-tag vote lookups -------------------------------------------------------------------
//
// The per-user vote overlay on the votable-tag read path. The tag rows themselves come from a cache;
// only the caller's own votes are read per request, which makes these among the highest-volume
// statements the app issues. They select two int4 columns off a hash-indexed key and are read-only
// with no transaction, so they port to Kysely 1:1.
//
// Deliberately NOT ordered: the source queries had no `orderBy`, and each table's primary key makes
// (tag, entity, user) unique, so callers resolve a vote by `find(v => v.tagId === tag.id)` — at most
// one row can match and row order is not observable. Adding an ORDER BY would change the plan, not
// the semantics.

/** One image's votes for the given user. */
export function listImageTagVotes(db: Kysely<DB>, input: { imageId: number; userId: number }) {
  return db
    .selectFrom('TagsOnImageVote')
    .select(['tagId', 'vote'])
    .where('imageId', '=', input.imageId)
    .where('userId', '=', input.userId)
    .execute();
}

/**
 * Bulk variant across several images.
 *
 * Returns `tagId`/`vote` only — NOT `imageId` — matching the source query. The caller folds these
 * into a flat tag list keyed by tagId alone, so a vote is applied per tag rather than per
 * (image, tag) pair. That is existing behaviour and is preserved here verbatim; widening the select
 * would change what the endpoint returns.
 */
export async function listImageTagVotesMany(
  db: Kysely<DB>,
  input: { imageIds: number[]; userId: number }
) {
  // Kysely compiles `in ([])` to the Postgres syntax error `IN ()`; Prisma returned []. The votable-tag
  // input schema accepts an empty `ids` array, so this guard is reachable from a real request.
  if (!input.imageIds.length) return [];
  return db
    .selectFrom('TagsOnImageVote')
    .select(['tagId', 'vote'])
    .where('imageId', 'in', input.imageIds)
    .where('userId', '=', input.userId)
    .execute();
}

/** One model's votes for the given user. */
export function listModelTagVotes(db: Kysely<DB>, input: { modelId: number; userId: number }) {
  return db
    .selectFrom('TagsOnModelsVote')
    .select(['tagId', 'vote'])
    .where('modelId', '=', input.modelId)
    .where('userId', '=', input.userId)
    .execute();
}
