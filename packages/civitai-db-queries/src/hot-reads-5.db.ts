import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Kysely ports of high-volume Prisma reads, served behind the default-off server Flipt flag
// `kysely-hot-reads-5`; off, the Prisma reads run unchanged. The app-side wrappers
// (<civitai>/src/server/services/hot-reads-5.reads.ts) map these rows to the exact Prisma payload,
// and <civitai>/src/server/services/__tests__/hot-reads-5.kysely-parity.test.ts compares the two
// against a real database.
//
// Each read is a single-table lookup by key, or a join where Prisma issued one query per relation.
// Every statement reads base TABLES only, never a view: the parity suite fails if one of them names
// a relation declared `/// @view`.
//
// Enum columns come back as their text, as Prisma returns them. The one enum ARRAY this module
// touches (`Announcement.domain`) is compared as `text[]`, so the statement needs neither the enum
// type's name (schema-qualified in the parity suite) nor the boot-time enum-array parsers.

/** One `KeyValue` row, `{ key, value }` (`value` is jsonb, parsed by pg), or undefined. */
export function getKeyValue(db: Kysely<DB>, key: string) {
  return db
    .selectFrom('KeyValue')
    .select(['KeyValue.key', 'KeyValue.value'])
    .where('KeyValue.key', '=', key)
    .executeTakeFirst();
}

/**
 * A post and its linked Model3D's visibility columns in ONE statement (Prisma: the post, then the
 * Model3D). No row is a missing post; a row with a NULL `model3dRowId` is a post with no Model3D
 * (an unset `model3dId`, or one pointing at no row).
 */
export function getPostModel3d(db: Kysely<DB>, postId: number) {
  return db
    .selectFrom('Post')
    .innerJoin('Model3D', 'Model3D.id', 'Post.model3dId')
    .select([
      'Post.id as postId',
      'Model3D.id as model3dRowId',
      'Model3D.userId as model3dUserId',
      'Model3D.status as model3dStatus',
      'Model3D.deletedAt as model3dDeletedAt',
    ])
    .where('Post.id', '=', postId)
    .executeTakeFirst();
}

export type DismissedAnnouncementsInput = {
  userId: number;
  now: Date;
  /** When set, only announcements whose `domain` overlaps these values. */
  domains?: string[];
};

/**
 * The announcement ids a user dismissed, of the announcements live at `now`: enabled, and `now`
 * inside the open-ended `[startsAt, endsAt]` window. Unordered, as the Prisma read is.
 */
export function listDismissedAnnouncementIds(
  db: Kysely<DB>,
  { userId, now, domains }: DismissedAnnouncementsInput
) {
  let query = db
    .selectFrom('AnnouncementDismissal')
    .innerJoin('Announcement', 'Announcement.id', 'AnnouncementDismissal.announcementId')
    .select('AnnouncementDismissal.announcementId')
    .where('AnnouncementDismissal.userId', '=', userId)
    .where((eb) =>
      eb.or([eb('Announcement.startsAt', '<=', now), eb('Announcement.startsAt', 'is', null)])
    )
    .where((eb) =>
      eb.or([eb('Announcement.endsAt', '>=', now), eb('Announcement.endsAt', 'is', null)])
    );
  if (domains)
    query = query.where(
      sql<boolean>`"Announcement"."domain"::text[] && ${sql.val(domains)}::text[]`
    );
  return query.execute();
}

/**
 * A post's owner and its collaborator rows in ONE statement (Prisma: the post, then the
 * collaborators). No row is a missing post; a single row with a NULL `collaboratorUserId` is a post
 * with none. Collaborator rows are unordered, as the Prisma read is.
 */
export function listPostCollaborators(db: Kysely<DB>, postId: number) {
  return db
    .selectFrom('Post')
    .leftJoin('EntityCollaborator', (join) =>
      join
        .onRef('EntityCollaborator.entityId', '=', 'Post.id')
    )
    .select([
      'Post.userId as postUserId',
      'EntityCollaborator.userId as collaboratorUserId',
      'EntityCollaborator.entityId',
      'EntityCollaborator.entityType',
      'EntityCollaborator.status',
    ])
    .where('Post.id', '=', postId)
    .execute();
}

/** The `HomeBlock` columns `getHomeBlockById` reads, or undefined. */
export function getHomeBlockRow(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('HomeBlock')
    .select([
      'HomeBlock.id',
      'HomeBlock.metadata',
      'HomeBlock.type',
      'HomeBlock.userId',
      'HomeBlock.sourceId',
    ])
    .where('HomeBlock.id', '=', id)
    .executeTakeFirst();
}

/** How many of a user's prizes are neither claimed nor voided, as a JS number. */
export async function countUnclaimedPrizes(db: Kysely<DB>, userId: number) {
  const row = await db
    .selectFrom('Prize')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('Prize.userId', '=', userId)
    .where('Prize.claimedAt', 'is', null)
    .executeTakeFirstOrThrow();
  return row.count;
}

/** The ids of a model's versions, unordered, as the Prisma read is. */
export function listModelVersionIds(db: Kysely<DB>, modelId: number) {
  return db
    .selectFrom('ModelVersion')
    .select(['ModelVersion.id', 'ModelVersion.modelId'])
    .where('ModelVersion.modelId', '=', modelId)
    .execute();
}

/** A user's reviews of a model (optionally one version), unordered, as the Prisma read is. */
export function listUserResourceReviews(
  db: Kysely<DB>,
  { modelId, modelVersionId, userId }: { modelId?: number; modelVersionId?: number; userId: number }
) {
  let query = db
    .selectFrom('ResourceReview')
    .select([
      'ResourceReview.id',
      'ResourceReview.modelId',
      'ResourceReview.modelVersionId',
      'ResourceReview.recommended',
      'ResourceReview.details',
      'ResourceReview.createdAt',
    ])
    .where('ResourceReview.userId', '=', userId);
  if (modelId !== undefined) query = query.where('ResourceReview.modelId', '=', modelId);
  if (modelVersionId !== undefined)
    query = query.where('ResourceReview.modelVersionId', '=', modelVersionId);
  return query.execute();
}

/**
 * A model version and its model, as the download path reads them, in ONE statement (Prisma: the
 * version, then the model). The inner join is the Prisma `model: { is: {} }` filter: a version whose
 * model row is gone returns nothing.
 */
export function getModelVersionForFile(db: Kysely<DB>, modelVersionId: number) {
  return db
    .selectFrom('ModelVersion')
    .leftJoin('Model', 'Model.id', 'ModelVersion.modelId')
    .select([
      'ModelVersion.id',
      'ModelVersion.status',
      'ModelVersion.name',
      'ModelVersion.trainedWords',
      'ModelVersion.createdAt',
      'ModelVersion.requireAuth',
      'ModelVersion.usageControl',
      'Model.id as modelId',
      'Model.name as modelName',
      'Model.type as modelType',
      'Model.publishedAt as modelPublishedAt',
      'Model.status as modelStatus',
      'Model.userId as modelUserId',
      'Model.mode as modelMode',
      'Model.nsfw as modelNsfw',
      'Model.availability as modelAvailability',
      'Model.poi as modelPoi',
    ])
    .where('ModelVersion.id', '=', modelVersionId)
    .executeTakeFirst();
}

/** The id of one of a user's image reactions, or undefined. */
export function getImageReactionId(
  db: Kysely<DB>,
  { userId, reaction, imageId }: { userId: number; reaction: string; imageId: number }
) {
  return db
    .selectFrom('ImageReaction')
    .select('ImageReaction.id')
    .where('ImageReaction.userId', '=', userId)
    .where('ImageReaction.imageId', '=', imageId)
    .limit(1)
    .executeTakeFirst();
}

/** An image's `nsfwLevel` and owner, or undefined. */
export function getImageNsfwLevelAndOwner(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('Image')
    .select(['Image.nsfwLevel', 'Image.userId'])
    .where('Image.id', '=', id)
    .where('Image.nsfwLevel', '>', 0)
    .executeTakeFirst();
}

/** An image's `postId` (NULL for an image in no post), or undefined for a missing image. */
export function getImagePostId(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('Image')
    .select('Image.userId as postId')
    .where('Image.id', '=', id)
    .executeTakeFirst();
}

/** A model's `meta`, `{ id, meta }`, or undefined. */
export function getModelMeta(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('Model')
    .select(['Model.id', 'Model.meta'])
    .where('Model.id', '=', id)
    .where('Model.status', '=', 'Published')
    .executeTakeFirst();
}
