import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Kysely ports of high-volume Prisma reads, served behind the default-off server Flipt flag
// `kysely-hot-reads-7`; off, the Prisma reads run unchanged. The app-side wrappers
// (<civitai>/src/server/services/hot-reads-7.reads.ts) map these rows to the exact Prisma payload,
// and <civitai>/src/server/services/__tests__/hot-reads-7.kysely-parity.test.ts compares the two
// against a real database.
//
// Every statement reads base TABLES only, never a view: the parity suite fails if one of them names
// a relation declared `/// @view`. None of them is given an empty id list: the wrappers answer that
// case without a statement, as Prisma does.

/** Whether any of these posts is a storyline chapter (`StorylineChapter.postId` is unique). */
export async function hasStorylineChapterForPosts(db: Kysely<DB>, postIds: number[]) {
  const row = await db
    .selectFrom('StorylineChapter')
    .select('StorylineChapter.id')
    .where('StorylineChapter.postId', 'in', postIds)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** The `.com` title of each of these models that has one, unordered. */
export function listModelSfwNames(db: Kysely<DB>, modelIds: number[]) {
  return db
    .selectFrom('Model')
    .select(['Model.id', 'Model.sfwName'])
    .where('Model.id', 'in', modelIds)
    .where('Model.sfwName', 'is not', null)
    .execute();
}

/** Each of these posts' model version id (NULL for a post on no version), unordered. */
export function listPostModelVersionIds(db: Kysely<DB>, postIds: number[]) {
  return db
    .selectFrom('Post')
    .select(['Post.id', 'Post.modelVersionId'])
    .where('Post.id', 'in', postIds)
    .execute();
}

/**
 * How many item ROWS a holder has of each definition of one type and set of statuses, unordered
 * (Prisma: `item.groupBy({ by: ['itemDefinitionId'], _count: { _all: true } })` filtered through
 * the `itemDefinition` relation). Rows are counted, not `quantity`.
 */
export function countHeldItemsByDefinitionId(
  db: Kysely<DB>,
  {
    holderType,
    holderId,
    type,
    statuses,
  }: { holderType: string; holderId: number; type: string; statuses: string[] }
) {
  return db
    .selectFrom('Item')
    .innerJoin('ItemDefinition', 'ItemDefinition.id', 'Item.itemDefinitionId')
    .select(['Item.itemDefinitionId', sql<number>`count(*)::int`.as('count')])
    .where('Item.holderType', '=', holderType)
    .where('Item.holderId', '=', holderId)
    .where('ItemDefinition.type', '=', type)
    .where('ItemDefinition.status', 'in', statuses)
    .groupBy('Item.itemDefinitionId')
    .execute();
}
