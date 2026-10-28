import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { jsonArrayFrom } from './infra/helpers';

// Kysely ports of high-volume Prisma reads, served behind the default-off server Flipt flag
// `kysely-hot-reads-6`; off, the Prisma reads run unchanged. The app-side wrappers
// (<civitai>/src/server/services/hot-reads-6.reads.ts) map these rows to the exact Prisma payload,
// and <civitai>/src/server/services/__tests__/hot-reads-6.kysely-parity.test.ts compares the two
// against a real database.
//
// Every statement reads base TABLES only, never a view: the parity suite fails if one of them names
// a relation declared `/// @view`.
//
// Nested relations are read with `jsonArrayFrom` only where every nested column survives JSON
// unchanged (integers, booleans, text, enums as text, JSON columns). Timestamps and floats are
// top-level columns, parsed by the pg parsers @civitai/db/kysely registers. Relations Prisma reads
// with no `orderBy` stay unordered here.

/**
 * The columns of `userWithCosmeticsSelect` (<civitai>/src/server/selectors/user.selector.ts): the
 * user, its profile picture (`profileImageSelect`, a left join, so a dangling id reads as no
 * picture) and its equipped cosmetics (`equippedAt IS NOT NULL AND equippedToId IS NULL`).
 */
function userWithCosmeticsQuery(db: Kysely<DB>) {
  return db
    .selectFrom('User')
    .leftJoin('Image as ProfilePicture', 'ProfilePicture.id', 'User.profilePictureId')
    .select((eb) => [
      'User.id',
      'User.username',
      'User.deletedAt',
      'User.image',
      'ProfilePicture.id as profilePictureId',
      'ProfilePicture.name as profilePictureName',
      'ProfilePicture.url as profilePictureUrl',
      'ProfilePicture.nsfwLevel as profilePictureNsfwLevel',
      'ProfilePicture.hash as profilePictureHash',
      'ProfilePicture.userId as profilePictureUserId',
      'ProfilePicture.ingestion as profilePictureIngestion',
      'ProfilePicture.type as profilePictureType',
      'ProfilePicture.width as profilePictureWidth',
      'ProfilePicture.height as profilePictureHeight',
      'ProfilePicture.metadata as profilePictureMetadata',
      jsonArrayFrom(
        eb
          .selectFrom('UserCosmetic')
          .innerJoin('Cosmetic', 'Cosmetic.id', 'UserCosmetic.cosmeticId')
          .select([
            'UserCosmetic.data',
            'Cosmetic.id as cosmeticId',
            'Cosmetic.data as cosmeticData',
            'Cosmetic.type as cosmeticType',
            'Cosmetic.source as cosmeticSource',
            'Cosmetic.name as cosmeticName',
          ])
          .whereRef('UserCosmetic.userId', '=', 'User.id')
          .where('UserCosmetic.equippedAt', 'is not', null)
          .where('UserCosmetic.equippedToId', 'is', null)
      ).as('cosmetics'),
    ]);
}

export type UserWithCosmeticsRow = NonNullable<
  Awaited<ReturnType<ReturnType<typeof userWithCosmeticsQuery>['executeTakeFirst']>>
>;

/** One user with cosmetics, by id, or undefined. */
export function getUserWithCosmetics(db: Kysely<DB>, userId: number) {
  return userWithCosmeticsQuery(db).where('User.id', '=', userId).executeTakeFirst();
}

/**
 * The owner (with cosmetics) of a model version's model, in ONE statement (Prisma: the version,
 * the model, the user, its cosmetics, their cosmetic rows and the profile picture). No row is a
 * missing version, a version whose model is gone, or a model whose user is gone.
 */
export function getModelVersionOwnerWithCosmetics(db: Kysely<DB>, modelVersionId: number) {
  return userWithCosmeticsQuery(db)
    .where('User.id', '=', (eb) =>
      eb
        .selectFrom('ModelVersion')
        .innerJoin('Model', 'Model.id', 'ModelVersion.modelId')
        .select('Model.userId')
        .where('ModelVersion.id', '=', modelVersionId)
    )
    .executeTakeFirst();
}

export type PostDetailViewer = { id: number; isModerator?: boolean } | undefined;

/**
 * The post row `getPostDetail` reads (`postSelect`, <civitai>/src/server/selectors/post.selector.ts)
 * minus its user, with the same visibility as `getPostDetailVisibility`
 * (<civitai>/src/server/services/post-detail-visibility.ts):
 *   - a moderator sees every post;
 *   - anyone sees a post published before `now` whose `nsfwLevel` is not 0;
 *   - a signed-in viewer also sees their own posts, and the posts of a collection they MANAGE.
 * `modelVersion` is the linked version only when it is published (a left join, so a post keeps its
 * row without one). The tags are those whose Tag row exists, unordered.
 */
export function getPostDetailRow(
  db: Kysely<DB>,
  { id, viewer, now }: { id: number; viewer: PostDetailViewer; now: Date }
) {
  let query = db
    .selectFrom('Post')
    .leftJoin('ModelVersion', (join) =>
      join
        .onRef('ModelVersion.id', '=', 'Post.modelVersionId')
    )
    .select((eb) => [
      'Post.id',
      'Post.nsfw',
      'Post.nsfwLevel',
      'Post.title',
      'Post.detail',
      'Post.modelVersionId',
      'ModelVersion.id as publishedModelVersionId',
      'Post.userId',
      'Post.publishedAt',
      'Post.availability',
      jsonArrayFrom(
        eb
          .selectFrom('TagsOnPost')
          .innerJoin('Tag', 'Tag.id', 'TagsOnPost.tagId')
          .select(['Tag.id', 'Tag.name', 'Tag.isCategory'])
          .whereRef('TagsOnPost.postId', '=', 'Post.id')
      ).as('tags'),
      'Post.collectionId',
    ])
    .where('Post.id', '=', id);

  if (!viewer?.isModerator) {
    query = query.where((eb) => {
      const published = eb.and([eb('Post.publishedAt', '<', now), eb('Post.nsfwLevel', '<>', 0)]);
      if (!viewer) return published;
      return eb.or([
        eb('Post.userId', '=', viewer.id),
        published,
        eb.and([
          eb('Post.collectionId', 'is not', null),
          eb.exists(
            eb
              .selectFrom('Collection')
              .innerJoin(
                'CollectionContributor',
                'CollectionContributor.collectionId',
                'Collection.id'
              )
              .select(sql<number>`1`.as('one'))
              .whereRef('Collection.id', '=', 'Post.collectionId')
              .where('CollectionContributor.userId', '=', viewer.id)
              .where(
                sql<boolean>`"CollectionContributor"."permissions"::text[] @> ARRAY['MANAGE']::text[]`
              )
          ),
        ]),
      ]);
    });
  }
  return query.executeTakeFirst();
}

/** A model's `poi` and owner, or undefined. */
export function getModelPoiAndOwner(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('Model')
    .select(['Model.poi', 'Model.userId'])
    .where('Model.id', '=', id)
    .executeTakeFirst();
}

/** A user's id by username, or undefined. */
export function getUserIdByUsername(db: Kysely<DB>, username: string) {
  return db
    .selectFrom('User')
    .select('User.id')
    .where('User.username', '=', username)
    .executeTakeFirst();
}

/** A user's `bannedAt` by username, or undefined. */
export function listUserBannedAtByUsername(db: Kysely<DB>, username: string) {
  return db
    .selectFrom('User')
    .select('User.bannedAt')
    .where('User.username', '=', username)
    .executeTakeFirst();
}

/**
 * A user's reviews' model and version ids, unordered. `recommended` undefined applies no filter, as
 * Prisma's does; `modelIds` bounds them to those models, and an empty list reads nothing (Prisma's
 * `in: []` matches no row).
 */
export async function listUserRecommendedReviews(
  db: Kysely<DB>,
  { userId, recommended, modelIds }: { userId: number; recommended?: boolean; modelIds?: number[] }
) {
  if (modelIds && !modelIds.length) return [];
  let query = db
    .selectFrom('ResourceReview')
    .select(['ResourceReview.modelId', 'ResourceReview.modelVersionId'])
    .where('ResourceReview.userId', '=', userId);
  if (modelIds) query = query.where('ResourceReview.modelId', 'in', modelIds);
  return query.execute();
}

/** The ids among `ids` that are model versions, unordered. An empty list reads nothing. */
export async function listExistingModelVersionIds(db: Kysely<DB>, ids: number[]) {
  if (!ids.length) return [];
  return db
    .selectFrom('ModelVersion')
    .select('ModelVersion.id')
    .where('ModelVersion.id', 'in', ids)
    .execute();
}

/**
 * The ACTIVE donation goals of these model versions (`entityType = 'ModelVersion'`), unordered.
 * An empty list reads nothing.
 */
export async function listActiveModelVersionDonationGoals(db: Kysely<DB>, versionIds: number[]) {
  if (!versionIds.length) return [];
  return db
    .selectFrom('DonationGoal')
    .select([
      'DonationGoal.id',
      'DonationGoal.goalAmount',
      'DonationGoal.title',
      'DonationGoal.active',
      'DonationGoal.userId',
      'DonationGoal.createdAt',
      'DonationGoal.description',
      'DonationGoal.entityId',
    ])
    .where('DonationGoal.entityType', '=', 'ModelVersion')
    .where('DonationGoal.entityId', 'in', versionIds)
    .execute();
}

/** The summed donations of each goal that has any, as JS numbers. An empty list reads nothing. */
export async function listDonationGoalTotals(db: Kysely<DB>, goalIds: number[]) {
  if (!goalIds.length) return [];
  return db
    .selectFrom('Donation')
    .select(['Donation.donationGoalId', sql<number>`SUM("Donation"."amount")::int`.as('total')])
    .where('Donation.donationGoalId', 'in', goalIds)
    .groupBy('Donation.donationGoalId')
    .execute();
}

/** A user's engagements with these model versions, unordered. An empty list reads nothing. */
export async function listModelVersionEngagements(
  db: Kysely<DB>,
  { userId, modelVersionIds }: { userId: number; modelVersionIds: number[] }
) {
  if (!modelVersionIds.length) return [];
  return db
    .selectFrom('ModelVersionEngagement')
    .select(['ModelVersionEngagement.modelVersionId', 'ModelVersionEngagement.type'])
    .where('ModelVersionEngagement.modelVersionId', 'in', modelVersionIds)
    .execute();
}

/**
 * A model's associated models and articles of one type, `index asc` (NULLS LAST, as Prisma's
 * `orderBy: { index: 'asc' }`). `type` undefined applies no type filter, as Prisma's does.
 */
export function listModelAssociationTargets(
  db: Kysely<DB>,
  { fromModelId, type }: { fromModelId: number; type?: string }
) {
  let query = db
    .selectFrom('ModelAssociations')
    .select(['ModelAssociations.toModelId', 'ModelAssociations.toArticleId'])
    .where('ModelAssociations.fromModelId', '=', fromModelId);
  if (type !== undefined) query = query.where('ModelAssociations.type', '=', type as never);
  return query.orderBy('ModelAssociations.index', 'desc').execute();
}

/**
 * The metric-privacy inputs of a model version, in ONE statement (Prisma: the version, its model,
 * the model's user): the version's `meta`, the model's `meta` and owner, the owner's `settings`.
 * Left joins, so a row with a NULL `modelRowId` (or `userRowId`) is a version whose model (or
 * user) is gone.
 */
export function getModelVersionPrivacyRow(db: Kysely<DB>, modelVersionId: number) {
  return db
    .selectFrom('ModelVersion')
    .leftJoin('Model', 'Model.id', 'ModelVersion.modelId')
    .leftJoin('User', 'User.id', 'Model.userId')
    .select([
      'ModelVersion.meta',
      'Model.id as modelRowId',
      'Model.meta as modelMeta',
      'Model.userId as modelUserId',
      'User.id as userRowId',
      'User.settings as userSettings',
    ])
    .where('ModelVersion.id', '=', modelVersionId)
    .executeTakeFirst();
}

export type DownloadFilesWhere = {
  modelVersionId: number;
  /** Only files not replaced (`replacedAt IS NULL`). */
  notReplaced?: boolean;
  type?: string;
  /** Only `visibility = 'Public'` files. */
  publicOnly?: boolean;
};

/**
 * A version's files as the download path selects them (`fileSelect`, file.service.ts), each with
 * its SHA256 hashes (unordered), unordered, as the Prisma read is.
 */
export function listDownloadFiles(db: Kysely<DB>, where: DownloadFilesWhere) {
  let query = db
    .selectFrom('ModelFile')
    .select((eb) => [
      'ModelFile.id',
      'ModelFile.url',
      'ModelFile.name',
      'ModelFile.overrideName',
      'ModelFile.type',
      'ModelFile.metadata',
      'ModelFile.sizeKB',
      jsonArrayFrom(
        eb
          .selectFrom('ModelFileHash')
          .select('ModelFileHash.hash')
          .whereRef('ModelFileHash.fileId', '=', 'ModelFile.id')
      ).as('hashes'),
    ])
    .where('ModelFile.modelVersionId', '=', where.modelVersionId);
  if (where.notReplaced) query = query.where('ModelFile.replacedAt', 'is', null);
  if (where.type !== undefined) query = query.where('ModelFile.type', '=', where.type);
  if (where.publicOnly) query = query.where('ModelFile.visibility', '=', 'Public');
  return query.execute();
}
