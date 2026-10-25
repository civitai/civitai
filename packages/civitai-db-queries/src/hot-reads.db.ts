import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { jsonArrayFrom, jsonObjectFrom } from './infra/helpers';

// Kysely ports of two hot Prisma reads, each a nested `select` that Prisma fans out into one query
// per relation:
//   - the model page's `modelWithDetailsSelect` read (`getModel`, model.service.ts),
//   - the creator card (`readUserCreatorViaKysely`, user-creator.reads.ts),
// plus two hot single-table reads: the image tags behind `imageTagsCache` and an image's comment
// thread.
// They are served behind the default-off server Flipt flag `kysely-hot-reads-2`; off, the Prisma
// reads run unchanged. The app-side wrappers map these rows to the exact Prisma payload, and
// <civitai>/src/server/services/__tests__/hot-reads-2.kysely-parity.test.ts compares the two
// against a real database.
//
// Nested relations are read with `jsonArrayFrom` / `jsonObjectFrom` ONLY where every nested column
// survives JSON unchanged: integers, booleans, text, enums (text) and JSON columns. Anything JSON
// would change (timestamps become strings, numerics lose their type) is selected as a top-level
// column of its own statement instead, where the pg parsers registered by @civitai/db/kysely apply.
//
// Unordered relations stay unordered, as Prisma left them: no Prisma relation read here has an
// `orderBy` except `modelVersions` (`index asc`), which is ordered the same way below.

/**
 * The model row behind `modelWithDetailsSelect`: the model's own columns, its creator (inner join —
 * the relation is required) with their rank, its report stats, its licenses and its metrics. One
 * statement; `undefined` when there is no such model.
 *
 * `allowCommercialUse` is an enum ARRAY, read as `text[]` so it parses to `string[]` without
 * depending on `registerEnumArrayTypeParsers`.
 */
export function getModelWithDetailsRow(db: Kysely<DB>, modelId: number) {
  return db
    .selectFrom('Model')
    .innerJoin('User', 'User.id', 'Model.userId')
    .leftJoin('UserRank', 'UserRank.userId', 'User.id')
    .leftJoin('ModelReportStat', 'ModelReportStat.modelId', 'Model.id')
    .select((eb) => [
      'Model.id',
      'Model.name',
      'Model.description',
      'Model.sfwName',
      'Model.sfwDescription',
      'Model.coverImageId',
      'Model.sfwCoverImageId',
      'Model.poi',
      'Model.minor',
      'Model.sfwOnly',
      'Model.nsfwLevel',
      'Model.nsfw',
      'Model.type',
      'Model.uploadType',
      'Model.updatedAt',
      'Model.deletedAt',
      'Model.deletedBy',
      'Model.status',
      'Model.checkpointType',
      'Model.allowNoCredit',
      sql<string[]>`${eb.ref('Model.allowCommercialUse')}::text[]`.as('allowCommercialUse'),
      'Model.allowDerivatives',
      'Model.allowDifferentLicense',
      'Model.publishedAt',
      'Model.locked',
      'Model.meta',
      'Model.mode',
      'Model.availability',
      'Model.lockedProperties',
      'ModelReportStat.modelId as reportStatsModelId',
      'ModelReportStat.ownershipProcessing as reportStatsOwnershipProcessing',
      'User.id as userId',
      'User.image as userImage',
      'User.username as userUsername',
      'User.deletedAt as userDeletedAt',
      'UserRank.userId as rankUserId',
      'UserRank.leaderboardRank as rankLeaderboardRank',
      jsonArrayFrom(
        eb
          .selectFrom('License')
          .innerJoin('_LicenseToModel', '_LicenseToModel.A', 'License.id')
          .select(['License.id', 'License.name', 'License.url'])
          .whereRef('_LicenseToModel.B', '=', 'Model.id')
      ).as('licenses'),
      jsonArrayFrom(
        eb
          .selectFrom('ModelMetric')
          .select([
            'ModelMetric.downloadCount',
            'ModelMetric.thumbsUpCount',
            'ModelMetric.thumbsDownCount',
            'ModelMetric.imageCount',
            'ModelMetric.collectedCount',
            'ModelMetric.tippedAmountCount',
            'ModelMetric.generationCount',
            'ModelMetric.commentCount',
          ])
          .whereRef('ModelMetric.modelId', '=', 'Model.id')
      ).as('metrics'),
    ])
    .where('Model.id', '=', modelId)
    .limit(1)
    .executeTakeFirst();
}

/**
 * The model's versions, `index asc` like the Prisma read, each with its metrics, generation coverage
 * and recommended resources (all JSON-safe). Files are read by `listModelWithDetailsFiles`, because
 * `scannedAt` is a timestamp.
 *
 * `licensingFee` is NUMERIC, read as text so the caller can rebuild the exact `Prisma.Decimal`
 * (the pg NUMERIC parser would turn it into a float).
 */
export function listModelWithDetailsVersions(db: Kysely<DB>, modelId: number) {
  return db
    .selectFrom('ModelVersion')
    .select((eb) => [
      'ModelVersion.id',
      'ModelVersion.modelId',
      'ModelVersion.name',
      'ModelVersion.description',
      'ModelVersion.steps',
      'ModelVersion.epochs',
      'ModelVersion.clipSkip',
      'ModelVersion.createdAt',
      'ModelVersion.updatedAt',
      'ModelVersion.trainedWords',
      'ModelVersion.trainingStatus',
      'ModelVersion.trainingDetails',
      'ModelVersion.flags',
      'ModelVersion.inaccurate',
      'ModelVersion.baseModel',
      'ModelVersion.baseModelType',
      'ModelVersion.availability',
      'ModelVersion.status',
      'ModelVersion.publishedAt',
      'ModelVersion.meta',
      'ModelVersion.settings',
      'ModelVersion.requireAuth',
      'ModelVersion.nsfwLevel',
      'ModelVersion.uploadType',
      'ModelVersion.usageControl',
      sql<string | null>`${eb.ref('ModelVersion.licensingFee')}::text`.as('licensingFee'),
      'ModelVersion.generatorLoaded',
      jsonArrayFrom(
        eb
          .selectFrom('ModelVersionMetric')
          .select([
            'ModelVersionMetric.generationCount',
            'ModelVersionMetric.downloadCount',
            'ModelVersionMetric.thumbsUpCount',
            'ModelVersionMetric.thumbsDownCount',
            'ModelVersionMetric.earnedAmount',
          ])
          .whereRef('ModelVersionMetric.modelVersionId', '=', 'ModelVersion.id')
      ).as('metrics'),
      jsonObjectFrom(
        eb
          .selectFrom('GenerationCoverage')
          .select(['GenerationCoverage.covered', 'GenerationCoverage.coveredNext'])
          .whereRef('GenerationCoverage.modelVersionId', '=', 'ModelVersion.id')
          .limit(1)
      ).as('generationCoverage'),
      jsonArrayFrom(
        eb
          .selectFrom('RecommendedResource')
          .select([
            'RecommendedResource.id',
            'RecommendedResource.resourceId',
            'RecommendedResource.settings',
          ])
          .whereRef('RecommendedResource.sourceId', '=', 'ModelVersion.id')
      ).as('recommendedResources'),
    ])
    .where('ModelVersion.modelId', '=', modelId)
    .orderBy('ModelVersion.index', 'asc')
    .execute();
}

/**
 * The live files (`dataPurged = false`, `replacedAt IS NULL`, as the Prisma relation filter) of
 * every version of one model, each with its hashes. The caller groups them by `modelVersionId`.
 */
export function listModelWithDetailsFiles(db: Kysely<DB>, modelId: number) {
  return db
    .selectFrom('ModelFile')
    .select((eb) => [
      'ModelFile.id',
      'ModelFile.url',
      'ModelFile.sizeKB',
      'ModelFile.name',
      'ModelFile.overrideName',
      'ModelFile.type',
      'ModelFile.visibility',
      'ModelFile.metadata',
      'ModelFile.pickleScanResult',
      'ModelFile.pickleScanMessage',
      'ModelFile.virusScanResult',
      'ModelFile.virusScanMessage',
      'ModelFile.scannedAt',
      'ModelFile.modelVersionId',
      jsonArrayFrom(
        eb
          .selectFrom('ModelFileHash')
          .select(['ModelFileHash.type', 'ModelFileHash.hash'])
          .whereRef('ModelFileHash.fileId', '=', 'ModelFile.id')
      ).as('hashes'),
    ])
    .where('ModelFile.modelVersionId', 'in', (eb) =>
      eb
        .selectFrom('ModelVersion')
        .select('ModelVersion.id')
        .where('ModelVersion.modelId', '=', modelId)
    )
    .where('ModelFile.dataPurged', '=', false)
    .where('ModelFile.replacedAt', 'is', null)
    .execute();
}

/**
 * The creator card in ONE statement: the user's own columns, stats, rank and profile picture (1:1,
 * left joins), links and equipped cosmetics (JSON-safe arrays), and the published-model count.
 *
 * The where clause is the Prisma one: the optional `id` / `username` equalities (an `undefined` one
 * is skipped, as Prisma skips it), `deletedAt IS NULL`, and `id <> systemId AND username <>
 * systemUsername` — which, like Prisma's `not`, excludes a NULL username.
 */
export function getUserCreatorRow(
  db: Kysely<DB>,
  input: {
    id?: number;
    username?: string;
    systemUserId: number;
    systemUsername: string;
  }
) {
  let query = db
    .selectFrom('User')
    .leftJoin('UserStat', 'UserStat.userId', 'User.id')
    .leftJoin('UserRank', 'UserRank.userId', 'User.id')
    .leftJoin('Image as ProfilePicture', 'ProfilePicture.id', 'User.profilePictureId')
    .select((eb) => [
      'User.id',
      'User.image',
      'User.username',
      'User.muted',
      'User.bannedAt',
      'User.deletedAt',
      'User.createdAt',
      'User.publicSettings',
      'User.settings',
      'User.excludeFromLeaderboards',
      'UserStat.userId as statsUserId',
      'UserStat.downloadCountAllTime',
      'UserStat.thumbsUpCountAllTime',
      'UserStat.followerCountAllTime',
      'UserStat.reactionCountAllTime',
      'UserStat.uploadCountAllTime',
      'UserStat.generationCountAllTime',
      'UserRank.userId as rankUserId',
      'UserRank.leaderboardRank',
      'UserRank.leaderboardId',
      'UserRank.leaderboardTitle',
      'UserRank.leaderboardCosmetic',
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
          .selectFrom('UserLink')
          .select(['UserLink.url', 'UserLink.type'])
          .whereRef('UserLink.userId', '=', 'User.id')
      ).as('links'),
      jsonArrayFrom(
        eb
          .selectFrom('UserCosmetic')
          .innerJoin('Cosmetic', 'Cosmetic.id', 'UserCosmetic.cosmeticId')
          .select([
            'UserCosmetic.data',
            'Cosmetic.id as cosmeticId',
            'Cosmetic.name as cosmeticName',
            'Cosmetic.description as cosmeticDescription',
            'Cosmetic.type as cosmeticType',
            'Cosmetic.source as cosmeticSource',
            'Cosmetic.data as cosmeticData',
          ])
          .whereRef('UserCosmetic.userId', '=', 'User.id')
          .where('UserCosmetic.equippedAt', 'is not', null)
      ).as('cosmetics'),
      eb
        .selectFrom('Model')
        .select(sql<number>`count(*)::int`.as('count'))
        .whereRef('Model.userId', '=', 'User.id')
        .where('Model.status', '=', 'Published')
        .as('modelCount'),
    ])
    .where('User.deletedAt', 'is', null)
    .where('User.id', '<>', input.systemUserId)
    .where('User.username', '<>', input.systemUsername);
  if (input.id !== undefined) query = query.where('User.id', '=', input.id);
  if (input.username !== undefined) query = query.where('User.username', '=', input.username);
  return query.limit(1).executeTakeFirst();
}

/**
 * The image tags behind `imageTagsCache`: `imageTagCompositeSelect` plus `imageId`, for a batch of
 * images, ordered `score desc, tagId asc` as the Prisma read was (the cache groups them by image in
 * row order). Empty `imageIds` short-circuits: Kysely would compile `IN ()`, Prisma returned `[]`.
 */
export async function listImageTagsForImages(db: Kysely<DB>, imageIds: number[]) {
  if (!imageIds.length) return [];
  return db
    .selectFrom('ImageTag')
    .select([
      'ImageTag.imageId',
      'ImageTag.tagId',
      'ImageTag.tagName',
      'ImageTag.tagType',
      'ImageTag.score',
      'ImageTag.upVotes',
      'ImageTag.downVotes',
      'ImageTag.tagNsfwLevel',
      'ImageTag.automated',
      'ImageTag.needsReview',
      'ImageTag.concrete',
      'ImageTag.lastUpvote',
      'ImageTag.source',
    ])
    .where('ImageTag.imageId', 'in', imageIds)
    .orderBy('ImageTag.score', 'desc')
    .orderBy('ImageTag.tagId', 'desc')
    .execute();
}

/** An image's comment thread (`Thread.imageId` is unique): its id, and `locked`. `undefined` if none. */
export function getImageThread(db: Kysely<DB>, imageId: number) {
  return db
    .selectFrom('Thread')
    .select(['Thread.id', 'Thread.locked'])
    .where('Thread.imageId', '=', imageId)
    .limit(1)
    .executeTakeFirst();
}
