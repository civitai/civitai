import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Kysely ports of the hot single-purpose Prisma reads behind the model page and the remix gallery
// card, served behind the default-off server Flipt flag `kysely-hot-reads-3`; off, the Prisma reads
// run unchanged. The app-side wrappers (<civitai>/src/server/services/hot-reads-3.reads.ts) map these
// rows to the exact Prisma payload, and
// <civitai>/src/server/services/__tests__/hot-reads-3.kysely-parity.test.ts compares the two against
// a real database.
//
//   - `listDefaultModelVersionRows`: the model page's default-version lookup
//     (`getDefaultModelVersion`), which Prisma reads as three queries (the model, its versions, the
//     versions' model) and this reads as one.
//   - `countSuggestedResources`, `getUserSettings`, `listModelPagePosts`: three reads
//     `getModelHandler` makes after the model row.
//   - `listViewerPendingRemixPlacements`: the viewer's own pending submissions on a remix gallery.
//
// Every statement reads base TABLES only, never a view: the parity suite fails if one of them names
// a relation declared `/// @view` in schema.full.prisma.
//
// Ordering follows the Prisma read exactly, including where Prisma does not break ties: the versions
// are `index asc` (NULLs last, the Postgres default Prisma also gets), the posts `id asc`, the
// placements `createdAt asc`.

/**
 * The model (by id) and up to ten of its versions in `index asc` order, optionally narrowed to one
 * version id, as ONE statement: the model LEFT JOINed to its versions, so a model with no matching
 * version is still one row (with every version column NULL) and a missing model is no rows. The
 * version filter sits in the JOIN condition, not the WHERE, for exactly that reason.
 *
 * `modelVersionId` is applied when truthy, as the Prisma read's `modelVersionId ? { id } : undefined`.
 */
export function listDefaultModelVersionRows(
  db: Kysely<DB>,
  input: { modelId: number; modelVersionId?: number }
) {
  const { modelId, modelVersionId } = input;
  return db
    .selectFrom('Model')
    .leftJoin('ModelVersion', (join) => {
      const onModel = join.onRef('ModelVersion.modelId', '=', 'Model.id');
      return modelVersionId ? onModel.on('ModelVersion.id', '=', modelVersionId) : onModel;
    })
    .select([
      'Model.id as modelId',
      'Model.userId as modelUserId',
      'Model.availability as modelAvailability',
      'Model.status as modelStatus',
      'ModelVersion.id as versionId',
      'ModelVersion.status as versionStatus',
      'ModelVersion.publishedAt as versionPublishedAt',
      'ModelVersion.availability as versionAvailability',
      'ModelVersion.trainingStatus as versionTrainingStatus',
    ])
    .where('Model.id', '=', modelId)
    .orderBy('ModelVersion.index', 'asc')
    .limit(10)
    .execute();
}

/** How many `Suggested` associations a model has, as a JS number. */
export async function countSuggestedResources(db: Kysely<DB>, modelId: number) {
  const row = await db
    .selectFrom('ModelAssociations')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('ModelAssociations.fromModelId', '=', modelId)
    .where('ModelAssociations.type', '=', 'Suggested')
    .executeTakeFirstOrThrow();
  return row.count;
}

/** A user's `settings` JSON; `undefined` when there is no such user. */
export function getUserSettings(db: Kysely<DB>, userId: number) {
  return db
    .selectFrom('User')
    .select('User.settings')
    .where('User.id', '=', userId)
    .executeTakeFirst();
}

/** The owner's posts on these versions, `id asc`. No statement for an empty id list. */
export async function listModelPagePosts(
  db: Kysely<DB>,
  input: { modelVersionIds: number[]; userId: number }
) {
  if (!input.modelVersionIds.length) return [];
  return db
    .selectFrom('Post')
    .select(['Post.id', 'Post.modelVersionId'])
    .where('Post.modelVersionId', 'in', input.modelVersionIds)
    .where('Post.userId', '=', input.userId)
    .orderBy('Post.id', 'asc')
    .execute();
}

/** One placer's pending placements on one target, oldest first, at most `limit`. */
export function listViewerPendingRemixPlacements(
  db: Kysely<DB>,
  input: { surface: string; targetType: string; targetId: number; placerId: number; limit: number }
) {
  return db
    .selectFrom('Placement')
    .select([
      'Placement.id',
      'Placement.amount',
      'Placement.free',
      'Placement.data',
      'Placement.createdAt',
      'Placement.expiresAt',
    ])
    .where('Placement.surface', '=', input.surface)
    .where('Placement.targetType', '=', input.targetType)
    .where('Placement.targetId', '=', input.targetId)
    .where('Placement.placerId', '=', input.placerId)
    .where('Placement.status', '=', 'pending')
    .orderBy('Placement.createdAt', 'asc')
    .limit(input.limit)
    .execute();
}
