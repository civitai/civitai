import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type { ManipulateType } from 'dayjs';
import dayjs from '~/shared/utils/dayjs';
import { isEmpty, uniq } from 'lodash-es';
import type { SearchParams, SearchResponse } from 'meilisearch';
import type { SessionUser } from 'next-auth';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import type { BaseModelType } from '~/server/common/constants';
import {
  CacheTTL,
  constants,
  FEATURED_MODEL_COLLECTION_ID,
  MODELS_SEARCH_INDEX,
  nsfwRestrictedBaseModels,
} from '~/server/common/constants';
import { ModelSort, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import type { Context } from '~/server/createContext';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-lag-helpers';
import { requestScannerTasks } from '~/server/jobs/scan-files';
import { logToAxiom } from '~/server/logging/client';
import { searchClient } from '~/server/meilisearch/client';
import { modelMetrics } from '~/server/metrics';
import { dataForModelsCache, modelTagCache, userContentOverviewCache } from '~/server/redis/caches';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import type { ModelVersionMeta } from '~/server/schema/model-version.schema';
import type {
  GetAllModelsOutput,
  GetModelVersionsSchema,
  IngestModelInput,
  LimitOnly,
  MigrateResourceToCollectionInput,
  ModelGallerySettingsSchema,
  ModelInput,
  ModelMeta,
  ModelUpsertInput,
  PrivateModelFromTrainingInput,
  PublishModelSchema,
  PublishPrivateModelInput,
  SetModelCollectionShowcaseInput,
  ToggleCheckpointCoverageInput,
  ToggleModelLockInput,
  UnpublishModelSchema,
} from '~/server/schema/model.schema';
import { ingestModelSchema } from '~/server/schema/model.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import type { UserSettingsSchema } from '~/server/schema/user.schema';
import {
  collectionsSearchIndex,
  imagesMetricsSearchIndex,
  imagesSearchIndex,
  modelsSearchIndex,
} from '~/server/search-index';
import type { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import type { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import { associatedResourceSelect } from '~/server/selectors/model.selector';
import { modelFileSelect } from '~/server/selectors/modelFile.selector';
import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { deleteBidsForModel, getLastAuctionReset } from '~/server/services/auction.service';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import {
  getAvailableCollectionItemsFilterForUser,
  getUserCollectionPermissionsById,
  saveItemInCollections,
} from '~/server/services/collection.service';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import { getUnavailableResources } from '~/server/services/generation/generation.service';
import type { ImagesForModelVersions } from '~/server/services/image.service';
import {
  getImagesForModelVersion,
  getImagesForModelVersionCache,
  queueImageSearchIndexUpdate,
} from '~/server/services/image.service';
import { getFilesForModelVersionCache } from '~/server/services/model-file.service';
import {
  bustMvCache,
  createModelVersionPostFromTraining,
  publishModelVersionsWithEarlyAccess,
} from '~/server/services/model-version.service';
import { getUserSubscription } from '~/server/services/subscriptions.service';
import { getCategoryTags } from '~/server/services/system-cache';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { getEarlyAccessDeadline } from '~/server/utils/early-access-helpers';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { RuleDefinition } from '~/server/utils/mod-rules';
import {
  DEFAULT_PAGE_SIZE,
  getCursor,
  getPagination,
  getPagingData,
} from '~/server/utils/pagination-helpers';
import {
  allBrowsingLevelsFlag,
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { CommercialUse, ModelType } from '~/shared/utils/prisma/enums';
import {
  AuctionType,
  Availability,
  EntityType,
  MetricTimeframe,
  ModelModifier,
  ModelStatus,
  ModelUploadType,
  TagTarget,
} from '~/shared/utils/prisma/enums';
import { decreaseDate, isFutureDate } from '~/utils/date-helpers';
import { prepareFile } from '~/utils/file-helpers';
import { fromJson, toJson } from '~/utils/json-helpers';
import { getS3Client } from '~/utils/s3-utils';
import { isDefined } from '~/utils/type-guards';
import type {
  GetAssociatedResourcesInput,
  GetModelsWithCategoriesSchema,
  SetAssociatedResourcesInput,
  SetModelsCategoryInput,
} from './../schema/model.schema';
import type { BaseModel } from '~/shared/constants/base-model.constants';

export const getModel = async <TSelect extends Prisma.ModelSelect>({
  id,
  user,
  select,
}: GetByIdInput & {
  user?: SessionUser;
  select: TSelect;
}) => {
  const db = await getDbWithoutLag('model', id);
  const result = await db.model.findFirst({
    where: {
      id,
    },
    select,
  });

  return result;
};

type ModelRaw = {
  id: number;
  name: string;
  description?: string | null;
  type: ModelType;
  poi?: boolean;
  minor?: boolean;
  sfwOnly?: boolean;
  nsfw: boolean;
  nsfwLevel: number;
  allowNoCredit?: boolean;
  allowCommercialUse?: CommercialUse[];
  allowDerivatives?: boolean;
  allowDifferentLicense?: boolean;
  status: string;
  createdAt: Date;
  lastVersionAt: Date;
  publishedAt: Date | null;
  locked: boolean;
  earlyAccessDeadline: Date;
  mode: string;
  rank: {
    downloadCount: number;
    thumbsUpCount: number;
    thumbsDownCount: number;
    commentCount: number;
    ratingCount: number;
    rating: number;
    collectedCount: number;
    tippedAmountCount: number;
  };
  tagsOnModels: {
    tagId: number;
    name: string;
  }[];
  hashes: {
    hash: string;
  }[];
  modelVersions: {
    id: number;
    name: string;
    earlyAccessTimeFrame: number;
    baseModel: BaseModel;
    baseModelType: BaseModelType;
    createdAt: Date;
    trainingStatus: string;
    trainedWords?: string[];
    vaeId: number | null;
    publishedAt: Date | null;
    status: ModelStatus;
    covered: boolean;
  }[];
  user: {
    id: number;
    username: string | null;
    deletedAt: Date | null;
    image: string;
  };
  cosmetic?: WithClaimKey<ContentDecorationCosmetic> | null;
  availability?: Availability;
};

export const getModelsRaw = async ({
  input,
  include,
  user: sessionUser,
}: {
  input: Omit<GetAllModelsOutput, 'limit' | 'page'> & {
    take?: number;
    skip?: number;
  };
  include?: Array<'details' | 'cosmetics'>;
  user?: { id: number; isModerator?: boolean; username?: string };
}) => {
  const {
    user,
    take,
    cursor,
    query,
    followed,
    archived,
    tag,
    tagname,
    username,
    baseModels,
    types,
    sort,
    period,
    periodMode,
    hidden,
    checkpointType,
    status,
    allowNoCredit,
    allowDifferentLicense,
    allowDerivatives,
    allowCommercialUse,
    ids,
    earlyAccess,
    supportsGeneration,
    fromPlatform,
    needsReview,
    collectionId,
    fileFormats,
    clubId,
    modelVersionIds,
    browsingLevel,
    excludedUserIds,
    collectionTagId,
    availability,
    disablePoi,
    disableMinor,
    isFeatured,
    poiOnly,
    minorOnly,
  } = input;

  // TODO yes, this will not work with pagination. dont have time to adjust the cursor for both dbs.
  let searchModelIds: number[] = [];
  if (query && searchClient) {
    const request: SearchParams = {
      limit: take ?? 100,
    };

    const results: SearchResponse<ModelSearchIndexRecord> = await searchClient
      .index(MODELS_SEARCH_INDEX)
      .search(query, request);

    // console.log(results.hits);
    searchModelIds = results.hits.map((m) => m.id);
    if (!searchModelIds.length) {
      return {
        items: [],
        isPrivate: false,
      };
    }
  }

  let pending = input.pending;
  const hasDraftModels = status?.includes(ModelStatus.Draft);

  if (hasDraftModels) {
    pending = true;
  }

  const includeDetails = !!include?.includes('details');
  const includeCosmetics = !!include?.includes('cosmetics');

  function ifDetails(sql: TemplateStringsArray) {
    return includeDetails ? Prisma.raw(sql[0]) : Prisma.empty;
  }

  let isPrivate = false;
  const AND: Prisma.Sql[] = [];

  if (searchModelIds.length) {
    AND.push(Prisma.sql`m.id IN (${Prisma.join(searchModelIds, ',')})`);
  }

  const userId = sessionUser?.id;
  const isModerator = sessionUser?.isModerator ?? false;

  // TODO.clubs: This is temporary until we are fine with displaying club stuff in public feeds.
  // At that point, we should be relying more on unlisted status which is set by the owner.
  const hidePrivateModels = !ids && !clubId && !username && !user && !followed && !collectionId;

  if (!archived) {
    AND.push(
      Prisma.sql`(m."mode" IS NULL OR m."mode" != ${ModelModifier.Archived}::"ModelModifier")`
    );
  }

  if (disablePoi) {
    AND.push(Prisma.sql`(m."poi" = false OR m."userId" = ${userId})`);
  }
  if (disableMinor) {
    AND.push(Prisma.sql`m."minor" = false`);
  }

  if (isModerator) {
    if (poiOnly) {
      AND.push(Prisma.sql`m."poi" = true`);
    }
    if (minorOnly) {
      AND.push(Prisma.sql`m."minor" = true`);
    }
  }

  if (needsReview && sessionUser?.isModerator) {
    AND.push(Prisma.sql`
      (
        m."meta"->>'needsReview' = 'true'
        OR
        EXISTS (
          SELECT 1 FROM "ModelVersion" mv
          WHERE mv."modelId" = m."id"
            AND mv."meta"->>'needsReview' = 'true'
        )
      )
    `);

    isPrivate = true;
  }

  if (tagname ?? tag) {
    const tagId = await dbRead.tag.findUnique({
      where: { name: tagname ?? tag },
      select: { id: true },
    });

    if (tagId) {
      AND.push(
        Prisma.sql`EXISTS (
            SELECT 1 FROM "TagsOnModels" tom
            WHERE tom."modelId" = m."id" AND tom."tagId" = ${tagId?.id}
          )`
      );
    }
  }

  if (fromPlatform) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ModelVersion" mv
      WHERE mv."trainingStatus" IS NOT NULL AND mv."modelId" = m."id"
    )`);
  }

  if (username || user) {
    const targetUser = await dbRead.user.findUnique({
      where: { username: (username || user) ?? '' },
      select: { id: true },
    });

    if (!targetUser) throw new Error('User not found');

    AND.push(Prisma.sql`u.id = ${targetUser.id}`);
  }

  if (types?.length) {
    AND.push(Prisma.sql`m.type = ANY(ARRAY[${Prisma.join(types)}]::"ModelType"[])`);
  }

  if (hidden && sessionUser?.id) {
    AND.push(
      Prisma.sql`EXISTS (
          SELECT 1 FROM "ModelEngagement" e
          WHERE e."modelId" = m."id" AND e."userId" = ${sessionUser?.id} AND e."type" = 'Hide'::"ModelEngagementType")
        `
    );
  }

  if (followed && sessionUser?.id) {
    const followedUsers = await dbRead.user.findUnique({
      where: { id: sessionUser.id },
      select: {
        engagingUsers: {
          select: { targetUser: { select: { id: true } } },
          where: { type: 'Follow' },
        },
      },
    });
    const followedUsersIds =
      followedUsers?.engagingUsers?.map(({ targetUser }) => targetUser.id) ?? [];

    if (!followedUsersIds.length) {
      // Return no results.
      AND.push(Prisma.sql`1 = 0`);
    } else {
      AND.push(Prisma.sql`u."id" IN (${Prisma.join(followedUsersIds, ',')})`);
    }

    isPrivate = true;
  }

  if (baseModels?.length) {
    AND.push(
      Prisma.sql`EXISTS (
          SELECT 1 FROM "ModelVersion" mv
          WHERE mv."modelId" = m."id"
            AND mv."baseModel" IN (${Prisma.join(baseModels, ',')})
        )`
    );
  }

  if (period && period !== MetricTimeframe.AllTime && periodMode !== 'stats') {
    AND.push(
      Prisma.sql`(m."lastVersionAt" >= ${decreaseDate(
        new Date(),
        1,
        period.toLowerCase() as ManipulateType
      )})`
    );
  }
  // If the user is not a moderator, only show published models
  if (!sessionUser?.isModerator || !status?.length) {
    AND.push(Prisma.sql`m."status" = ${ModelStatus.Published}::"ModelStatus"`);
  } else if (sessionUser?.isModerator) {
    if (status?.includes(ModelStatus.Unpublished)) status.push(ModelStatus.UnpublishedViolation);
    AND.push(
      Prisma.sql`m."status" IN (${Prisma.raw(
        status.map((s) => `'${s}'::"ModelStatus"`).join(',')
      )})`
    );

    isPrivate = true;
  }

  // Filter by model permissions
  if (allowCommercialUse && allowCommercialUse.length > 0) {
    AND.push(
      Prisma.sql`m."allowCommercialUse" && ARRAY[${Prisma.join(
        allowCommercialUse,
        ','
      )}]::"CommercialUse"[]`
    );
  }

  if (allowDerivatives !== undefined)
    AND.push(Prisma.sql`m."allowDerivatives" = ${allowDerivatives}`);
  if (allowDifferentLicense !== undefined)
    AND.push(Prisma.sql`m."allowDifferentLicense" = ${allowDifferentLicense}`);
  if (allowNoCredit !== undefined) AND.push(Prisma.sql`m."allowNoCredit" = ${allowNoCredit}`);

  if (!!ids?.length) AND.push(Prisma.sql`m."id" IN (${Prisma.join(ids, ',')})`);

  if (!!modelVersionIds?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ModelVersion" mv
      WHERE mv."id" IN (${Prisma.join(modelVersionIds, ',')})
        AND mv."modelId" = m."id"
    )`);
  }

  if (checkpointType && (!types?.length || types?.includes('Checkpoint'))) {
    const TypeOr: Prisma.Sql[] = [
      Prisma.sql`m."checkpointType" = ${checkpointType}::"CheckpointType"`,
    ];

    const otherTypes = (types ?? []).filter((t) => t !== 'Checkpoint');

    if (otherTypes?.length) {
      TypeOr.push(
        Prisma.sql`m."type" IN (${Prisma.raw(
          otherTypes.map((t) => `'${t}'::"ModelType"`).join(',')
        )})`
      );
    } else TypeOr.push(Prisma.sql`m."type" != 'Checkpoint'`);

    AND.push(Prisma.sql`(${Prisma.join(TypeOr, ' OR ')})`);
  }

  if (earlyAccess) {
    AND.push(Prisma.sql`m."earlyAccessDeadline" >= ${new Date()}`);
  }
  if (availability) {
    if (availability === Availability.Private && !(username || isModerator)) {
      throw throwAuthorizationError();
    }

    AND.push(Prisma.sql`m."availability" = ${availability}::"Availability"`);
  } else if (!isModerator) {
    // Makes it so that our feeds never contain private stuff by default.
    AND.push(Prisma.sql`m."availability" != 'Private'::"Availability"`);
  }

  if (supportsGeneration) {
    AND.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "GenerationCoverage" gc WHERE gc."modelId" = m."id" AND gc."covered" = true)`
    );
  }

  if (isFeatured) {
    const featuredModels = await getFeaturedModels();
    AND.push(
      Prisma.sql`m."id" IN (${Prisma.join(
        featuredModels.map((m) => m.modelId),
        ','
      )})`
    );
  }

  if (collectionId) {
    const permissions = await getUserCollectionPermissionsById({
      userId: sessionUser?.id,
      id: collectionId,
    });

    if (!permissions.read) {
      return { items: [], isPrivate: true };
    }

    const { rawAND: collectionItemModelsAND }: { rawAND: Prisma.Sql[] } =
      getAvailableCollectionItemsFilterForUser({ permissions, userId: sessionUser?.id });

    AND.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "CollectionItem" ci
        WHERE ci."modelId" = m."id"
        AND ci."collectionId" = ${collectionId}
        AND ${Prisma.join(collectionItemModelsAND, ' AND ')}
        ${collectionTagId ? Prisma.sql`AND ci."tagId" = ${collectionTagId}` : Prisma.empty}
      )`
    );

    isPrivate = !permissions.publicCollection;
  }

  // Exclude user content
  if (excludedUserIds?.length) {
    AND.push(Prisma.sql`m."userId" NOT IN (${Prisma.join(excludedUserIds, ',')})`);
  }

  let orderBy = `m."lastVersionAt" DESC NULLS LAST, m."id" DESC`;

  if (sort === ModelSort.HighestRated)
    orderBy = `mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId"`;
  else if (sort === ModelSort.MostLiked)
    orderBy = `mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId"`;
  else if (sort === ModelSort.MostDownloaded)
    orderBy = `mm."downloadCount" DESC, mm."thumbsUpCount" DESC, mm."modelId"`;
  else if (sort === ModelSort.MostDiscussed)
    orderBy = `mm."commentCount" DESC, mm."thumbsUpCount" DESC, mm."modelId"`;
  else if (sort === ModelSort.MostCollected)
    orderBy = `mm."collectedCount" DESC, mm."thumbsUpCount" DESC, mm."modelId"`;
  // else if (sort === ModelSort.MostTipped)
  //   orderBy = `mm."tippedAmountCount" DESC, mm."thumbsUpCount" DESC, mm."modelId"`;
  else if (sort === ModelSort.ImageCount)
    orderBy = `mm."imageCount" DESC, mm."thumbsUpCount" DESC, mm."modelId"`;
  else if (sort === ModelSort.Oldest) orderBy = `m."lastVersionAt" ASC, m."id"`;

  // eslint-disable-next-line prefer-const
  let { where: cursorClause, prop: cursorProp } = getCursor(orderBy, cursor);
  if (cursorClause) AND.push(cursorClause);

  if (!!fileFormats?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ModelFile" mf
      JOIN "ModelVersion" mv ON mf."modelVersionId" = mv."id" AND mv."modelId" = m."id"
      WHERE mf."modelVersionId" = mv."id"
        AND mf."type" = 'Model'
        AND (${Prisma.join(
          fileFormats.map((format) => Prisma.raw(`mf."metadata" @> '{"format": "${format}"}'`)),
          ' OR '
        )})
    )`);
  }

  const browsingLevelQuery = Prisma.sql`(m."nsfwLevel" & ${browsingLevel}) != 0`;
  if (pending && (isModerator || userId)) {
    if (isModerator) {
      AND.push(Prisma.sql`(${browsingLevelQuery} OR m."nsfwLevel" = 0)`);
    } else if (userId) {
      AND.push(
        Prisma.sql`(${browsingLevelQuery} OR (m."nsfwLevel" = 0 AND m."userId" = ${userId}))`
      );
    }
  } else {
    AND.push(browsingLevelQuery);
  }

  const WITH: Prisma.Sql[] = [];
  if (clubId) {
    WITH.push(Prisma.sql`
      "clubModels" AS (
        SELECT
          mv."modelId" "modelId",
          MAX(mv."id") "modelVersionId"
        FROM "EntityAccess" ea
        JOIN "ModelVersion" mv ON mv."id" = ea."accessToId"
        LEFT JOIN "ClubTier" ct ON ea."accessorType" = 'ClubTier' AND ea."accessorId" = ct."id" AND ct."clubId" = ${clubId}
        WHERE (
            (
             ea."accessorType" = 'Club' AND ea."accessorId" = ${clubId}
            )
            OR (
              ea."accessorType" = 'ClubTier' AND ct."clubId" = ${clubId}
            )
          )
          AND ea."accessToType" = 'ModelVersion'
        GROUP BY mv."modelId"
      )
    `);
  }

  const queryWith = WITH.length > 0 ? Prisma.sql`WITH ${Prisma.join(WITH, ', ')}` : Prisma.sql``;

  const modelQuery = Prisma.sql`
    ${queryWith}
    SELECT
      m."id",
      m."name",
      ${ifDetails`
        m."description",
        m."allowNoCredit",
        m."allowCommercialUse",
        m."allowDerivatives",
        m."allowDifferentLicense",
      `} m."type",
      m."minor",
      m."sfwOnly",
      m."poi",
      m."nsfw",
      m."nsfwLevel",
      m."status",
      m."createdAt",
      m."lastVersionAt",
      m."publishedAt",
      m."locked",
      m."earlyAccessDeadline",
      m."mode",
      m."availability",
      jsonb_build_object(
        'downloadCount', mm."downloadCount",
        'thumbsUpCount', mm."thumbsUpCount",
        'thumbsDownCount', mm."thumbsDownCount",
        'commentCount', mm."commentCount",
        'ratingCount', mm."ratingCount",
        'rating', mm."rating",
        'collectedCount', mm."collectedCount",
        'tippedAmountCount', mm."tippedAmountCount"
      )                                               as "rank",
      jsonb_build_object(
        'id', u."id",
        'username', u."username",
        'deletedAt', u."deletedAt",
        'image', u."image"
      )                                               as "user",
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} as "cursorId"
    FROM "Model" m
         JOIN "ModelMetric" mm ON mm."modelId" = m."id" AND mm."timeframe" = ${period}::"MetricTimeframe"
         JOIN "User" u ON m."userId" = u.id
      ${clubId ? Prisma.sql`JOIN "clubModels" cm ON cm."modelId" = m."id"` : Prisma.sql``}
    WHERE
      ${Prisma.join(AND, ' AND ')}
    ORDER BY
      ${Prisma.raw(orderBy)}
    LIMIT ${(take ?? 100) + 1}
  `;

  // TODO - break into multiple queries
  // model query
  // model version query
  // additional subqueries?

  const models = await dbRead.$queryRaw<(ModelRaw & { cursorId: string | bigint | null })[]>(
    modelQuery
  );

  const userIds = models.map((m) => m.user.id);
  const profilePictures = await getProfilePicturesForUsers(userIds);
  const userCosmetics = await getCosmeticsForUsers(userIds);

  // Get versions, hash, and tags from cache
  const modelIds = models.map((m) => m.id);
  const modelData = await dataForModelsCache.fetch(modelIds);

  const cosmetics = includeCosmetics
    ? await getCosmeticsForEntity({ ids: models.map((m) => m.id), entity: 'Model' })
    : {};

  let nextCursor: string | bigint | undefined;
  if (take && models.length > take) {
    models.pop(); //Remove excess model
    // Use final item as cursor to grab next page
    nextCursor = models[models.length - 1]?.cursorId || undefined;
  }

  return {
    items: models
      .map(({ rank, cursorId, ...model }) => {
        const data = modelData[model.id.toString()];
        if (!data) return null;

        let modelVersions = data.versions;

        // Apply version filters
        if (!sessionUser?.isModerator || !status?.length) {
          modelVersions = modelVersions.filter((mv) => mv.status === ModelStatus.Published);
        }

        if (baseModels) {
          modelVersions = modelVersions.filter((mv) => baseModels.includes(mv.baseModel));
        }

        if (!!modelVersionIds?.length) {
          modelVersions = modelVersions.filter((mv) => modelVersionIds.includes(mv.id));
        }

        // Filter out NSFW versions for license-restricted base models
        // Models with nsfwLevel > R cannot use base models with restricted licenses
        if (nsfwRestrictedBaseModels.length > 0) {
          modelVersions = modelVersions.filter(
            (mv) =>
              !(
                (mv.nsfwLevel & nsfwBrowsingLevelsFlag) !== 0 &&
                nsfwRestrictedBaseModels.includes(mv.baseModel)
              )
          );
        }

        if (hidePrivateModels) {
          modelVersions = modelVersions.filter(
            (mv) => mv.availability === 'Public' || mv.availability === 'EarlyAccess'
          );
        }

        // eject if no versions
        if (modelVersions.length === 0) return null;

        // If not getting full details, only return the latest version
        if (!includeDetails) modelVersions = modelVersions.slice(0, 1);

        if (!!input.excludedTagIds && input.excludedTagIds.length) {
          // Support for excluded tags
          const hasExcludedTag = data.tags.some((tag) =>
            (input.excludedTagIds ?? []).includes(tag.tagId)
          );
          if (hasExcludedTag) return null;
        }

        return {
          ...model,
          rank: {
            [`downloadCount${input.period}`]: rank.downloadCount,
            [`thumbsUpCount${input.period}`]: rank.thumbsUpCount,
            [`thumbsDownCount${input.period}`]: rank.thumbsDownCount,
            [`commentCount${input.period}`]: rank.commentCount,
            [`ratingCount${input.period}`]: rank.ratingCount,
            [`rating${input.period}`]: rank.rating,
            [`collectedCount${input.period}`]: rank.collectedCount,
            [`tippedAmountCount${input.period}`]: rank.tippedAmountCount,
          },
          modelVersions,
          hashes: data.hashes,
          tagsOnModels: data.tags,
          user: {
            ...model.user,
            profilePicture: profilePictures?.[model.user.id] ?? null,
            cosmetics: userCosmetics[model.user.id] ?? [],
          },
          cosmetic: cosmetics[model.id] ?? null,
        };
      })
      .filter(isDefined),
    nextCursor,
    isPrivate,
  };
};

/** @deprecated use getModelsRaw */
export const getModels = async <TSelect extends Prisma.ModelSelect>({
  input,
  select,
  user: sessionUser,
  count = false,
}: {
  input: Omit<GetAllModelsOutput, 'limit' | 'page' | 'cursor'> & {
    take?: number;
    skip?: number;
    cursor?: number;
  };
  select: TSelect;
  user?: SessionUser;
  count?: boolean;
}) => {
  const {
    take,
    skip,
    cursor,
    query,
    tag,
    tagname,
    user,
    username,
    baseModels,
    types,
    sort,
    period,
    periodMode,
    favorites,
    hidden,
    excludedTagIds,
    excludedUserIds,
    excludedModelIds,
    checkpointType,
    status,
    allowNoCredit,
    allowDifferentLicense,
    allowDerivatives,
    allowCommercialUse,
    ids,
    needsReview,
    earlyAccess,
    supportsGeneration,
    followed,
    collectionId,
    fileFormats,
    browsingLevel,
    clubId,
  } = input;

  const AND: Prisma.Enumerable<Prisma.ModelWhereInput> = [];
  const lowerQuery = query?.toLowerCase();
  let isPrivate = false;

  // If the user is not a moderator, only show published models
  if (!sessionUser?.isModerator || !status?.length) {
    AND.push({ status: ModelStatus.Published });
  } else if (sessionUser?.isModerator) {
    if (status?.includes(ModelStatus.Unpublished)) status.push(ModelStatus.UnpublishedViolation);
    AND.push({ status: { in: status } });
    isPrivate = true;
  }

  // Filter by model permissions
  if (allowCommercialUse && allowCommercialUse.length > 0) {
    AND.push({ allowCommercialUse: { hasSome: allowCommercialUse } });
  }
  if (allowDerivatives !== undefined) AND.push({ allowDerivatives });
  if (allowDifferentLicense !== undefined) AND.push({ allowDifferentLicense });
  if (allowNoCredit !== undefined) AND.push({ allowNoCredit });

  if (query) {
    AND.push({
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        {
          modelVersions: {
            some: {
              files: query
                ? {
                    some: {
                      hashes: { some: { hash: query } },
                    },
                  }
                : undefined,
            },
          },
        },
        {
          modelVersions: {
            some: {
              trainedWords: { has: lowerQuery },
            },
          },
        },
      ],
    });
  }
  if (!!ids?.length) AND.push({ id: { in: ids } });
  if (excludedUserIds && excludedUserIds.length && !username) {
    AND.push({ userId: { notIn: excludedUserIds } });
  }
  // if (excludedTagIds && excludedTagIds.length && !username) {
  //   AND.push({
  //     tagsOnModels: { none: { tagId: { in: excludedTagIds } } },
  //   });
  // }
  if (excludedModelIds && !hidden && !username) {
    AND.push({ id: { notIn: excludedModelIds } });
  }
  if (checkpointType && (!types?.length || types?.includes('Checkpoint'))) {
    const TypeOr: Prisma.Enumerable<Prisma.ModelWhereInput> = [{ checkpointType }];
    if (types?.length) {
      const otherTypes = types.filter((t) => t !== 'Checkpoint');
      TypeOr.push({ type: { in: otherTypes } });
    } else TypeOr.push({ type: { not: 'Checkpoint' } });
    AND.push({ OR: TypeOr });
  }
  if (needsReview && sessionUser?.isModerator) {
    AND.push({
      OR: [
        { meta: { path: ['needsReview'], equals: true } },
        { modelVersions: { some: { meta: { path: ['needsReview'], equals: true } } } },
      ],
    });
    isPrivate = true;
  }
  if (earlyAccess) {
    AND.push({ earlyAccessDeadline: { gte: new Date() } });
  }

  if (supportsGeneration) {
    AND.push({ generationCoverage: { some: { covered: true } } });
  }

  // Filter only followed users
  if (!!sessionUser && followed) {
    const followedUsers = await dbRead.user.findUnique({
      where: { id: sessionUser.id },
      select: {
        engagingUsers: {
          select: { targetUser: { select: { id: true } } },
          where: { type: 'Follow' },
        },
      },
    });
    const followedUsersIds =
      followedUsers?.engagingUsers?.map(({ targetUser }) => targetUser.id) ?? [];
    AND.push({ userId: { in: followedUsersIds } });
    isPrivate = true;
  }

  if (collectionId) {
    const permissions = await getUserCollectionPermissionsById({
      userId: sessionUser?.id,
      id: collectionId,
    });

    if (!permissions.read) {
      return { items: [], isPrivate: true };
    }

    const {
      AND: collectionItemModelsAND,
    }: { AND: Prisma.Enumerable<Prisma.CollectionItemWhereInput> } =
      getAvailableCollectionItemsFilterForUser({ permissions, userId: sessionUser?.id });

    AND.push({
      collectionItems: {
        some: {
          collectionId,
          AND: collectionItemModelsAND,
        },
      },
    });
    isPrivate = !permissions.publicCollection;
  }

  if (!!fileFormats?.length) {
    AND.push({
      modelVersions: {
        some: {
          files: {
            some: {
              type: 'Model',
              OR: fileFormats.map((format) => ({
                metadata: { path: ['format'], equals: format },
              })),
            },
          },
        },
      },
    });
  }

  // TODO - filter by browsingLevel
  const where: Prisma.ModelWhereInput = {
    // tagsOnModels: tagname ?? tag ? { some: { tag: { name: tagname ?? tag } } } : undefined,
    user: username || user ? { username: username ?? user } : undefined,
    type: types?.length ? { in: types } : undefined,
    engagements: favorites
      ? { some: { userId: sessionUser?.id, type: 'Notify' } }
      : hidden
      ? { some: { userId: sessionUser?.id, type: 'Hide' } }
      : undefined,
    AND: AND.length ? AND : undefined,
    modelVersions: { some: { baseModel: baseModels?.length ? { in: baseModels } : undefined } },
    lastVersionAt:
      period !== MetricTimeframe.AllTime && periodMode !== 'stats'
        ? { gte: decreaseDate(new Date(), 1, period.toLowerCase() as ManipulateType) }
        : undefined,
  };
  if (favorites || hidden) isPrivate = true;

  const orderBy: Prisma.ModelOrderByWithRelationInput = {
    lastVersionAt: { sort: 'desc', nulls: 'last' },
  };

  // No more rank view...
  // if (sort === ModelSort.HighestRated) orderBy = { rank: { [`rating${period}Rank`]: 'asc' } };
  // else if (sort === ModelSort.MostLiked)
  //   orderBy = { rank: { [`thumbsUpCount${period}Rank`]: 'asc' } };
  // else if (sort === ModelSort.MostDownloaded)
  //   orderBy = { rank: { [`downloadCount${period}Rank`]: 'asc' } };
  // else if (sort === ModelSort.MostDiscussed)
  //   orderBy = { rank: { [`commentCount${period}Rank`]: 'asc' } };
  // else if (sort === ModelSort.MostCollected)
  //   orderBy = { rank: { [`collectedCount${period}Rank`]: 'asc' } };
  // else if (sort === ModelSort.MostTipped)
  //   orderBy = { rank: { [`tippedAmountCount${period}Rank`]: 'asc' } };
  // else if (sort === ModelSort.ImageCount)
  //   orderBy = { rank: { [`imageCount${period}Rank`]: 'asc' } };

  const items = await dbRead.model.findMany({
    take,
    skip,
    where,
    cursor: cursor ? { id: cursor } : undefined,
    orderBy,
    select,
  });

  if (count) {
    const count = await dbRead.model.count({ where });
    return { items, count };
  }

  return { items, isPrivate };
};

export const rescanModel = async ({ id }: GetByIdInput) => {
  const modelFiles = await dbRead.modelFile.findMany({
    where: { modelVersion: { modelId: id } },
    select: { id: true, url: true },
  });

  const s3 = getS3Client();
  const tasks = modelFiles.map((file) => async () => {
    await requestScannerTasks({
      file,
      s3,
      tasks: ['Hash', 'Scan', 'ParseMetadata'],
      lowPriority: true,
    });
  });

  await limitConcurrency(tasks, 10);
};

export type GetModelsWithImagesAndModelVersions = AsyncReturnType<
  typeof getModelsWithImagesAndModelVersions
>['items'][0];

export const getModelsWithImagesAndModelVersions = async ({
  input,
  user,
}: {
  input: GetAllModelsOutput;
  user?: SessionUser;
}) => {
  input.limit = input.limit ?? 100;

  let modelVersionWhere: Prisma.ModelVersionWhereInput | undefined = {};

  if (!user?.isModerator || !input.status?.length) {
    modelVersionWhere.status = ModelStatus.Published;
  }

  if (input.baseModels) {
    modelVersionWhere.baseModel = { in: input.baseModels };
  }

  if (Object.keys(modelVersionWhere).length === 0) {
    modelVersionWhere = undefined;
  }

  const { items, isPrivate, nextCursor } = await getModelsRaw({
    input: { ...input, take: input.limit },
    user,
    include: ['cosmetics'],
  });

  const modelVersionIds = items
    .filter((model) => model.mode !== ModelModifier.TakenDown)
    .flatMap((m) => m.modelVersions)
    .map((m) => m.id);

  let modelVersionImages: Record<
    number,
    { modelVersionId: number; images: ImagesForModelVersions[] }
  > = {};
  const { excludedTagIds, status } = input;
  if (!!modelVersionIds.length) {
    if (input.pending) {
      const images = await getImagesForModelVersion({
        modelVersionIds,
        imagesPerVersion: 20,
        pending: input.pending,
        browsingLevel: input.browsingLevel,
        user,
        include: excludedTagIds ? ['tags'] : undefined,
      });
      for (const image of images) {
        if (!modelVersionImages[image.modelVersionId])
          modelVersionImages[image.modelVersionId] = {
            modelVersionId: image.modelVersionId,
            images: [],
          };
        modelVersionImages[image.modelVersionId].images.push(image);
      }
    } else {
      modelVersionImages = await getImagesForModelVersionCache(modelVersionIds);
    }
  }

  const includeDrafts = status?.includes(ModelStatus.Draft);

  const unavailableGenResources = await getUnavailableResources();
  const result = {
    nextCursor,
    isPrivate,
    items: items
      .map(({ hashes, modelVersions, rank, tagsOnModels, ...model }) => {
        const [version] = modelVersions;
        if (!version) {
          return null;
        }
        const versionImages = modelVersionImages[version.id]?.images ?? [];
        const filteredImages = excludedTagIds
          ? versionImages.filter(
              (x) => x.tags && x.tags.every((id) => !excludedTagIds.includes(id))
            )
          : versionImages;

        const showImageless =
          (user?.isModerator || model.user.id === user?.id) &&
          (input.user || input.username || includeDrafts);
        if (!filteredImages.length && !showImageless) return null;

        const canGenerate =
          !!version?.covered && unavailableGenResources.indexOf(version.id) === -1;

        return {
          ...model,
          tags: tagsOnModels.map((x) => x.tagId), // not sure why we even use scoring here...
          hashes: hashes.map((hash) => hash.toLowerCase()),
          rank: {
            downloadCount: rank?.[`downloadCount${input.period}`] ?? 0,
            thumbsUpCount: rank?.[`thumbsUpCount${input.period}`] ?? 0,
            thumbsDownCount: rank?.[`thumbsDownCount${input.period}`] ?? 0,
            commentCount: rank?.[`commentCount${input.period}`] ?? 0,
            ratingCount: rank?.[`ratingCount${input.period}`] ?? 0,
            collectedCount: rank?.[`collectedCount${input.period}`] ?? 0,
            tippedAmountCount: rank?.[`tippedAmountCount${input.period}`] ?? 0,
            rating: rank?.[`rating${input.period}`] ?? 0,
          },
          version,
          // // !important - for feed queries, when `model.nsfw === true`, we set all image `nsfwLevel` values to `NsfwLevel.XXX`
          // images: model.nsfw
          //   ? versionImages.map((x) => ({ ...x, nsfwLevel: NsfwLevel.XXX }))
          //   : versionImages,
          images: filteredImages,
          canGenerate,
        };
      })
      .filter(isDefined),
  };

  return result;
};

export const getModelVersionsMicro = async ({
  id,
  excludeUnpublished: excludeDrafts,
}: GetModelVersionsSchema) => {
  const versions = await dbRead.modelVersion.findMany({
    where: {
      modelId: id,
      status: excludeDrafts ? ModelStatus.Published : undefined,
    },
    orderBy: { index: 'asc' },
    select: {
      id: true,
      name: true,
      index: true,
      earlyAccessEndsAt: true,
      createdAt: true,
      publishedAt: true,
    },
  });

  return versions.map(({ earlyAccessEndsAt, ...v }) => ({
    ...v,
    isEarlyAccess: earlyAccessEndsAt && isFutureDate(earlyAccessEndsAt),
  }));
};

export const updateModelById = async ({
  id,
  data,
}: {
  id: number;
  data: Prisma.ModelUpdateInput;
}) => {
  const model = await dbWrite.model.update({
    where: { id },
    data,
  });

  await userContentOverviewCache.bust(model.userId);

  return model;
};

export const deleteModelById = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & {
  userId: number;
  isModerator?: boolean;
}) => {
  if (!isModerator) {
    const versions = await dbRead.modelVersion.findMany({
      where: { modelId: id },
      select: { id: true, meta: true },
    });

    if (
      versions.some((v) => {
        const meta = v.meta as ModelVersionMeta | null;
        if (meta?.hadEarlyAccessPurchase) {
          return true;
        }
      })
    ) {
      throw throwBadRequestError(
        'Cannot unpublish a model with early access purchases. You may still unpublish individual versions.'
      );
    }
  }

  const deletedModel = await dbWrite.$transaction(async (tx) => {
    const model = await tx.model.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: ModelStatus.Deleted,
        deletedBy: userId,
        modelVersions: {
          updateMany: {
            where: { status: { in: [ModelStatus.Published, ModelStatus.Scheduled] } },
            data: { status: ModelStatus.Deleted },
          },
        },
      },
      select: { id: true, userId: true, nsfwLevel: true, modelVersions: { select: { id: true } } },
    });
    if (!model) return null;

    // TODO - account for case that a user restores a model and doesn't want all posts to be re-published
    const versionIds = model.modelVersions.map(({ id }) => id);
    if (versionIds.length > 0)
      await tx.$executeRaw`
        UPDATE "Post"
        SET "metadata" = "metadata" || jsonb_build_object(
          'unpublishedAt', ${new Date().toISOString()},
          'unpublishedBy', ${userId}
                                       )
        WHERE
            "publishedAt" IS NOT NULL
        AND "userId" = ${model.userId}
        AND "modelVersionId" IN (${Prisma.join(
          model.modelVersions.map(({ id }) => id),
          ','
        )})
      `;

    return model;
  });

  if (deletedModel) {
    await userContentOverviewCache.bust(deletedModel.userId);
  }
  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
  await deleteBidsForModel({ modelId: id });

  return deletedModel;
};

export const restoreModelById = async ({ id }: GetByIdInput) => {
  const model = await dbWrite.model.update({
    where: { id },
    data: {
      deletedAt: null,
      status: 'Draft',
      deletedBy: null,
      modelVersions: {
        updateMany: { where: { status: 'Deleted' }, data: { status: 'Draft' } },
      },
    },
  });

  await userContentOverviewCache.bust(model.userId);

  return model;
};

export const permaDeleteModelById = async ({
  id,
}: GetByIdInput & {
  userId: number;
}) => {
  const deletedModel = await dbWrite.$transaction(async (tx) => {
    const model = await tx.model.findUnique({
      where: { id },
      select: { id: true, userId: true, nsfwLevel: true, modelVersions: { select: { id: true } } },
    });
    if (!model) return null;

    await tx.post.deleteMany({
      where: {
        userId: model.userId,
        modelVersionId: { in: model.modelVersions.map(({ id }) => id) },
      },
    });

    const deletedModel = await tx.model.delete({ where: { id } });
    return deletedModel;
  });

  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
  await deleteBidsForModel({ modelId: id });

  return deletedModel;
};

const prepareModelVersions = (versions: ModelInput['modelVersions']) => {
  return versions.map(({ files, ...version }) => {
    // Keep tab whether there's a file format-type conflict.
    // We needed to manually check for this because Prisma doesn't do
    // error handling all too well
    const fileConflicts: Record<string, boolean> = {};

    return {
      ...version,
      files: files.map((file) => {
        const preparedFile = prepareFile(file);
        const {
          type,
          metadata: { format, size },
        } = preparedFile;
        const key = [size, type, format].filter(Boolean).join('-');

        if (fileConflicts[key])
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Only 1 ${key.replace(
              '-',
              ' '
            )} file can be attached to a version, please review your uploads and try again`,
          });
        else fileConflicts[key] = true;

        return preparedFile;
      }),
    };
  });
};

export const upsertModel = async (
  input: ModelUpsertInput & {
    userId: number;
    // meta?: Prisma.ModelCreateInput['meta']; // TODO.manuel: hardcoding meta type since it causes type issues in lots of places if we set it in the schema
    isModerator?: boolean;
    gallerySettings?: Partial<ModelGallerySettingsSchema>;
  }
) => {
  if (input.description) await throwOnBlockedLinkDomain(input.description);
  if (!input.isModerator) {
    for (const key of input.lockedProperties ?? []) delete input[key as keyof typeof input];
  }

  const {
    id,
    tagsOnModels,
    userId,
    templateId,
    bountyId,
    meta,
    isModerator,
    status,
    gallerySettings,
    ...data
  } = input;

  // don't allow updating of locked properties
  if (!isModerator) {
    const lockedProperties = data.lockedProperties ?? [];
    for (const prop of lockedProperties) {
      const key = prop as keyof typeof data;
      if (data[key] !== undefined) delete data[key];
    }
  }

  // Validate NSFW + restricted base model combination
  if (data.nsfw && 'modelVersions' in input && input.modelVersions) {
    const modelVersions = input.modelVersions as Array<{ baseModel: string }>;
    const hasRestrictedBaseModel = modelVersions.some((version) =>
      nsfwRestrictedBaseModels.includes(version.baseModel as BaseModel)
    );

    if (hasRestrictedBaseModel) {
      throw throwBadRequestError(
        `NSFW models cannot use base models with license restrictions. Restricted base models: ${nsfwRestrictedBaseModels.join(
          ', '
        )}`
      );
    }
  }

  if (!id || templateId) {
    const result = await dbWrite.model.create({
      select: { id: true, nsfwLevel: true, meta: true, availability: true },
      data: {
        ...data,
        status,
        gallerySettings,
        meta:
          bountyId || meta
            ? {
                ...((meta ?? {}) as MixedObject),
                bountyId,
              }
            : undefined,
        userId,
        tagsOnModels: tagsOnModels
          ? {
              create: tagsOnModels.map((tag) => {
                const name = tag.name.toLowerCase().trim();
                return {
                  tag: {
                    connectOrCreate: {
                      where: { name },
                      create: { name, target: [TagTarget.Model] },
                    },
                  },
                };
              }),
            }
          : undefined,
      },
    });

    const modelMeta = result.meta as ModelMeta | null;
    if (modelMeta?.showcaseCollectionId) {
      await saveItemInCollections({
        input: {
          collections: [{ collectionId: modelMeta.showcaseCollectionId }],
          modelId: result.id,
          type: 'Model',
          userId,
          isModerator,
        },
      });
    }

    await modelTagCache.bust(result.id);
    await preventReplicationLag('model', result.id);
    return { ...result, meta: modelMeta };
  } else {
    const beforeUpdate = await dbRead.model.findUnique({
      where: { id },
      select: {
        name: true,
        description: true,
        poi: true,
        userId: true,
        minor: true,
        sfwOnly: true,
        nsfw: true,
        gallerySettings: true,
        meta: true,
      },
    });
    if (!beforeUpdate) return null;

    const isOwner = beforeUpdate.userId === userId || isModerator;
    if (!isOwner) return null;

    const prevGallerySettings = beforeUpdate.gallerySettings as ModelGallerySettingsSchema;

    const result = await dbWrite.model.update({
      select: {
        id: true,
        name: true,
        description: true,
        nsfwLevel: true,
        poi: true,
        minor: true,
        sfwOnly: true,
        nsfw: true,
        gallerySettings: true,
        status: true,
        meta: true,
        availability: true,
      },
      where: { id },
      data: {
        ...data,
        meta: isEmpty(meta) ? Prisma.JsonNull : meta,
        gallerySettings: {
          ...prevGallerySettings,
          level: input.minor || input.sfwOnly ? sfwBrowsingLevelsFlag : prevGallerySettings?.level,
        },
        tagsOnModels: tagsOnModels
          ? {
              deleteMany: {
                tagId: {
                  notIn: tagsOnModels.filter(isTag).map((x) => x.id),
                },
              },
              connectOrCreate: tagsOnModels.filter(isTag).map((tag) => ({
                where: { modelId_tagId: { tagId: tag.id, modelId: id as number } },
                create: { tagId: tag.id },
              })),
              create: tagsOnModels.filter(isNotTag).map((tag) => {
                const name = tag.name.toLowerCase().trim();
                return {
                  tag: {
                    connectOrCreate: {
                      where: { name },
                      create: { name, target: [TagTarget.Model] },
                    },
                  },
                };
              }),
            }
          : undefined,
      },
    });
    await preventReplicationLag('model', id);

    // Check any changes that would require a search index update
    const poiChanged = result.poi !== beforeUpdate.poi;
    const minorChanged =
      result.minor !== beforeUpdate.minor || result.sfwOnly !== beforeUpdate.sfwOnly;
    const nsfwChanged = result.nsfw !== beforeUpdate.nsfw;
    const nameChanged = input.name !== beforeUpdate.name;
    const descriptionChanged = input.description !== beforeUpdate.description;
    const modelMeta = result.meta as ModelMeta | null;
    const showcaseCollectionChanged =
      modelMeta?.showcaseCollectionId !== (beforeUpdate.meta as ModelMeta)?.showcaseCollectionId;

    // Update search index if listing changes
    if (tagsOnModels || poiChanged || minorChanged) {
      await modelTagCache.bust(result.id);
      await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);
    }

    const newGallerySettings = result.gallerySettings as ModelGallerySettingsSchema;
    const galleryBrowsingLevelChanged = prevGallerySettings?.level !== newGallerySettings?.level;

    if (galleryBrowsingLevelChanged) await redis.del(`${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${id}`);

    await userContentOverviewCache.bust(userId);

    // Ingest model if it's published and any of the following fields have changed:
    if (
      (result.status === 'Published' || result.status === 'Scheduled') &&
      (poiChanged || minorChanged || nsfwChanged || nameChanged || descriptionChanged)
    ) {
      const parsedModel = ingestModelSchema.parse(result);
      // Run it in the background to prevent blocking the request
      ingestModel({ ...parsedModel }).catch((error) =>
        logToAxiom({ type: 'error', name: 'model-ingestion', error, modelId: parsedModel.id })
      );
    }

    if (minorChanged || poiChanged) {
      // Update all images:
      const modelVersions = await dbWrite.modelVersion.findMany({
        where: { modelId: id },
        select: { id: true },
      });

      const modelVersionIds = modelVersions.map(({ id }) => id);

      if (modelVersionIds.length !== 0) {
        const imageIds = await dbRead.$queryRaw<{ id: number }[]>`
          SELECT i.id
          FROM "Image" i
          JOIN "Post" p ON i."postId" = p.id
          WHERE p."modelVersionId" IN (${Prisma.join(modelVersionIds, ',')})
        `;

        if (imageIds.length !== 0) {
          await dbWrite.$executeRaw`
            UPDATE "Image"
              SET minor = ${result.minor},
                  poi = ${result.poi}
            WHERE id IN (${Prisma.join(
              imageIds.map(({ id }) => id),
              ','
            )})
          `;

          await imagesSearchIndex.queueUpdate(
            imageIds.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
          );
        }
      }
    }

    if (showcaseCollectionChanged) {
      if (modelMeta?.showcaseCollectionId) {
        saveItemInCollections({
          input: {
            collections: [{ collectionId: modelMeta.showcaseCollectionId }],
            modelId: id,
            type: 'Model',
            userId,
            isModerator,
          },
        }).catch((error) =>
          logToAxiom({
            type: 'error',
            name: 'save-model-showcase-collection',
            error,
            message: error.message,
          })
        );
      } else {
        saveItemInCollections({
          input: {
            collections: [],
            removeFromCollectionIds: [
              (beforeUpdate.meta as ModelMeta)?.showcaseCollectionId as number,
            ],
            userId,
            isModerator,
            modelId: id,
            type: 'Model',
          },
        }).catch((error) =>
          logToAxiom({
            type: 'error',
            name: 'save-model-showcase-collection',
            error,
            message: error.message,
          })
        );
      }
    }

    return result;
  }
};

export const publishModelById = async ({
  id,
  versionIds,
  publishedAt,
  meta,
  republishing,
}: PublishModelSchema & {
  meta?: ModelMeta;
  republishing?: boolean;
}) => {
  const includeVersions = versionIds && versionIds.length > 0;
  let status: ModelStatus = ModelStatus.Published;
  if (publishedAt && publishedAt > new Date()) status = ModelStatus.Scheduled;
  else publishedAt = new Date();

  const model = await dbWrite.$transaction(
    async (tx) => {
      const model = await tx.model.update({
        where: { id },
        data: {
          status,
          publishedAt: !republishing ? publishedAt : undefined,
          meta: isEmpty(meta) ? Prisma.JsonNull : meta,
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
          description: true,
          poi: true,
          nsfw: true,
          minor: true,
          sfwOnly: true,
          type: true,
          userId: true,
          modelVersions: { select: { id: true, baseModel: true } },
          status: true,
        },
      });

      // Validate NSFW + restricted base model combination
      if (model.nsfw) {
        const hasRestrictedBaseModel = model.modelVersions.some((version) =>
          nsfwRestrictedBaseModels.includes(version.baseModel as BaseModel)
        );

        if (hasRestrictedBaseModel) {
          throw throwBadRequestError(
            `NSFW models cannot use base models with license restrictions. Restricted base models: ${nsfwRestrictedBaseModels.join(
              ', '
            )}`
          );
        }
      }

      if (includeVersions) {
        if (status === ModelStatus.Published) {
          // Publish model versions with early access check:
          await publishModelVersionsWithEarlyAccess({
            modelVersionIds: versionIds,
            publishedAt: !republishing ? publishedAt : undefined,
            tx,
          });
        } else if (status === ModelStatus.Scheduled) {
          // Schedule model versions:
          await tx.modelVersion.updateMany({
            where: { id: { in: versionIds } },
            data: { status, publishedAt: !republishing ? publishedAt : undefined },
          });
        }

        await tx.$executeRaw`
          UPDATE "Post"
          SET "publishedAt" = CASE
                                WHEN "metadata" ->> 'prevPublishedAt' IS NOT NULL
                                  THEN to_timestamp("metadata" ->> 'prevPublishedAt', 'YYYY-MM-DD"T"HH24:MI:SS.MS')
                                ELSE ${publishedAt}
            END,
              "metadata"    = "metadata" - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt'
          WHERE
            "userId" = ${model.userId}
          AND "modelVersionId" IN (${Prisma.join(versionIds, ',')})
        `;
      }
      if (!republishing && !meta?.unpublishedBy) await updateModelLastVersionAt({ id, tx });

      return model;
    },
    { timeout: 10000 }
  );

  await userContentOverviewCache.bust(model.userId);

  if (includeVersions && status !== ModelStatus.Scheduled) {
    const versionIds = model.modelVersions.map((x) => x.id);
    await bustMvCache(versionIds, model.id);
  }

  // Fetch affected posts to update their images in search index
  const posts = await dbRead.post.findMany({
    where: { modelVersionId: { in: model.modelVersions.map((x) => x.id) }, userId: model.userId },
    select: { id: true },
  });
  const images = await dbRead.image.findMany({
    where: { postId: { in: posts.map((x) => x.id) } },
    select: { id: true },
  });

  // Update search index for model
  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);
  // Update search index for all affected images
  await imagesSearchIndex.queueUpdate(
    images.map((x) => ({ id: x.id, action: SearchIndexUpdateQueueAction.Update }))
  );
  await imagesMetricsSearchIndex.queueUpdate(
    images.map((x) => ({ id: x.id, action: SearchIndexUpdateQueueAction.Update }))
  );

  // Run it in the background to prevent blocking the request
  if (!republishing) {
    const parsedModel = ingestModelSchema.parse(model);
    ingestModel({ ...parsedModel }).catch((error) =>
      logToAxiom({ type: 'error', name: 'model-ingestion', error, modelId: parsedModel.id })
    );
  }

  return model;
};

export const unpublishModelById = async ({
  id,
  reason,
  customMessage,
  meta,
  userId,
  isModerator,
}: UnpublishModelSchema & {
  meta?: ModelMeta;
  userId: number;
  isModerator?: boolean;
}) => {
  if (!isModerator) {
    const versions = await dbRead.modelVersion.findMany({
      where: { modelId: id },
      select: { id: true, meta: true },
    });

    if (
      versions.some((v) => {
        const meta = v.meta as ModelVersionMeta | null;
        if (meta?.hadEarlyAccessPurchase) {
          return true;
        }
      })
    ) {
      throw throwBadRequestError(
        'Cannot unpublish a model with early access purchases. You may still unpublish individual versions.'
      );
    }
  }

  const model = await dbWrite.$transaction(
    async (tx) => {
      const unpublishedAt = new Date().toISOString();
      const updatedMeta = {
        ...meta,
        ...(reason
          ? {
              unpublishedReason: reason,
              customMessage,
            }
          : {}),
        unpublishedAt,
        unpublishedBy: userId,
      };
      const updatedModel = await tx.model.update({
        where: { id },
        data: {
          status: reason ? ModelStatus.UnpublishedViolation : ModelStatus.Unpublished,
          meta: updatedMeta,
          modelVersions: {
            updateMany: {
              where: { status: { in: [ModelStatus.Published, ModelStatus.Scheduled] } },
              data: { status: ModelStatus.Unpublished, meta: updatedMeta },
            },
          },
        },
        select: { userId: true, modelVersions: { select: { id: true } } },
      });

      const versionIds = updatedModel.modelVersions.map((x) => x.id);
      await tx.$executeRaw`
        UPDATE "Post"
        SET "metadata"    = "metadata" || jsonb_build_object(
          'unpublishedAt', ${unpublishedAt},
          'unpublishedBy', ${userId},
          'prevPublishedAt', "publishedAt"
                                          ),
            "publishedAt" = NULL
        WHERE
          "publishedAt" IS NOT NULL
        AND "userId" = ${updatedModel.userId}
        AND "modelVersionId" IN (${Prisma.join(versionIds)})
      `;

      await userContentOverviewCache.bust(updatedModel.userId);

      return updatedModel;
    },
    { timeout: 30000, maxWait: 10000 }
  );

  // Fetch affected posts to remove their images from search index
  const posts = await dbRead.post.findMany({
    where: { modelVersionId: { in: model.modelVersions.map((x) => x.id) }, userId: model.userId },
    select: { id: true },
  });
  const images = await dbRead.image.findMany({
    where: { postId: { in: posts.map((x) => x.id) } },
    select: { id: true },
  });

  // Remove this model from search index as it's been unpublished.
  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
  // Remove all affected images from search index
  await queueImageSearchIndexUpdate({
    ids: images.map((x) => x.id),
    action: SearchIndexUpdateQueueAction.Delete,
  });

  await deleteBidsForModel({ modelId: id });

  return model;
};

export const getVaeFiles = async ({ vaeIds }: { vaeIds: number[] }) => {
  const files = (
    await dbRead.modelFile.findMany({
      where: {
        modelVersionId: { in: vaeIds },
        type: 'Model',
      },
      select: { ...modelFileSelect, modelVersionId: true },
    })
  ).map((x) => {
    x.type = 'VAE';
    return { ...x, metadata: x.metadata as BasicFileMetadata };
  });

  return files;
};

export const getDraftModelsByUserId = async <TSelect extends Prisma.ModelSelect>({
  userId,
  select,
  page,
  limit = DEFAULT_PAGE_SIZE,
}: GetAllSchema & {
  userId: number;
  select: TSelect;
}) => {
  const { take, skip } = getPagination(limit, page);
  const where: Prisma.ModelFindManyArgs['where'] = {
    userId,
    OR: [
      {
        status: { notIn: [ModelStatus.Published, ModelStatus.Deleted] },
        uploadType: ModelUploadType.Created,
      },
      {
        uploadType: ModelUploadType.Trained,
        status: { in: [ModelStatus.Unpublished, ModelStatus.UnpublishedViolation] },
      },
    ],
  };

  const items = await dbRead.model.findMany({
    select,
    skip,
    take,
    where,
    orderBy: { updatedAt: 'desc' },
  });
  const count = await dbRead.model.count({ where });

  return getPagingData({ items, count }, take, page);
};

export const getTrainingModelsByUserId = async <TSelect extends Prisma.ModelVersionSelect>({
  userId,
  select,
  page,
  limit = DEFAULT_PAGE_SIZE,
}: GetAllSchema & {
  userId: number;
  select: TSelect;
}) => {
  const { take, skip } = getPagination(limit, page);
  const where: Prisma.ModelVersionFindManyArgs['where'] = {
    status: { in: [ModelStatus.Draft, ModelStatus.Training] },
    uploadType: ModelUploadType.Trained,
    model: {
      userId,
      status: { notIn: [ModelStatus.Deleted] },
    },
  };

  const items = await dbWrite.modelVersion.findMany({
    select,
    skip,
    take,
    where,
    orderBy: { updatedAt: 'desc' },
  });
  const count = await dbWrite.modelVersion.count({ where });

  return getPagingData({ items, count }, take, page);
};

export const getAvailableModelsByUserId = async ({ userId }: { userId: number }) => {
  return dbRead.model.findMany({
    select: { id: true },
    where: {
      userId,
      status: { in: [ModelStatus.Published] },
    },
    orderBy: { updatedAt: 'desc' },
  });
};

export const getRecentlyManuallyAdded = async ({
  take,
  userId,
}: LimitOnly & { userId: number }) => {
  const data = await dbRead.imageResourceNew.findMany({
    select: { modelVersion: { select: { modelId: true } } },
    where: {
      detected: false,
      image: { userId },
    },
    orderBy: { image: { createdAt: 'desc' } },
    take,
  });
  return uniq(data.map((d) => d.modelVersion?.modelId).filter(isDefined));
};

export const getRecentlyRecommended = async ({ take, userId }: LimitOnly & { userId: number }) => {
  const data = await dbRead.recommendedResource.findMany({
    select: { resource: { select: { modelId: true } } },
    where: {
      source: { model: { userId } },
    },
    orderBy: { source: { updatedAt: 'desc' } },
    take,
  });
  return uniq(data.map((d) => d.resource.modelId));
};

export const getRecentlyBid = async ({ take, userId }: LimitOnly & { userId: number }) => {
  const data = await dbRead.bid.findMany({
    select: { entityId: true },
    where: {
      userId,
      auction: {
        auctionBase: {
          type: AuctionType.Model,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take,
  });
  return uniq(data.map((d) => d.entityId));
};

// export const getFeaturedModels = async ({ take }: LimitOnly) => {
//   const homeblocks = await getSystemHomeBlocks({ input: {} });
//   const featuredModelCollection = homeblocks.find(
//     (h) => h.type === HomeBlockType.Collection && h.metadata.link === '/models'
//   );
//   const collectionId = featuredModelCollection?.metadata?.collection?.id ?? 104;

//   const featured = await dbRead.collectionItem.findMany({
//     where: { collectionId },
//     select: { modelId: true },
//     orderBy: { createdAt: 'desc' },
//     take,
//   });

//   return featured.map(({ modelId }) => modelId).filter(isDefined);
// };

export const toggleLockModel = async ({ id, locked }: ToggleModelLockInput) => {
  const model = await dbWrite.model.update({ where: { id }, data: { locked } });
  await userContentOverviewCache.bust(model.userId);
};

export async function toggleLockComments({ id, locked }: { id: number; locked: boolean }) {
  await dbWrite.$executeRaw`
    UPDATE "Model"
    SET meta = jsonb_set(meta, '{commentsLocked}', to_jsonb(${locked}))
    WHERE id = ${id}
  `;
}

export const getSimpleModelWithVersions = async ({
  id,
  ctx,
}: GetByIdInput & {
  ctx?: Context;
}) => {
  const model = await getModel({
    id,
    user: ctx?.user,
    select: {
      id: true,
      name: true,
      createdAt: true,
      locked: true,
      status: true,
      user: { select: userWithCosmeticsSelect },
    },
  });
  if (!model) throw throwNotFoundError();
  return model;
};

export const updateModelEarlyAccessDeadline = async ({ id }: GetByIdInput) => {
  // Using dbWrite here cause immediately after a version has been unlocked it may update the model,
  // meaning we need the latest version.
  const model = await dbWrite.model.findUnique({
    where: { id },
    select: {
      id: true,
      publishedAt: true,
      modelVersions: {
        where: { status: ModelStatus.Published },
        select: { id: true, earlyAccessEndsAt: true, createdAt: true },
      },
    },
  });
  if (!model) throw throwNotFoundError();

  const { modelVersions } = model;
  const nextEarlyAccess = modelVersions.find((v) => !!v.earlyAccessEndsAt);

  if (nextEarlyAccess) {
    await updateModelById({
      id,
      data: {
        earlyAccessDeadline: nextEarlyAccess.earlyAccessEndsAt,
      },
    });
  } else {
    await updateModelById({ id, data: { earlyAccessDeadline: null } });
  }
};

export async function updateModelLastVersionAt({
  id,
  tx,
}: {
  id: number;
  tx?: Prisma.TransactionClient;
}) {
  const dbClient = tx ?? dbWrite;

  const modelVersion = await dbClient.modelVersion.findFirst({
    where: { modelId: id, status: ModelStatus.Published, publishedAt: { not: null } },
    select: { publishedAt: true },
    orderBy: { publishedAt: 'desc' },
  });
  if (!modelVersion) return;

  try {
    const model = await dbClient.model.update({
      where: { id },
      data: { lastVersionAt: modelVersion.publishedAt },
    });

    await userContentOverviewCache.bust(model.userId);
  } catch (error) {
    logToAxiom({ type: 'lastVersionAt-failure', modelId: id, message: (error as Error).message });
    throw error;
  }
}

export const getAllModelsWithCategories = async ({
  userId,
  limit,
  page,
}: GetModelsWithCategoriesSchema) => {
  const { take, skip } = getPagination(limit, page);
  const where: Prisma.ModelFindManyArgs['where'] = {
    status: { in: [ModelStatus.Published, ModelStatus.Draft, ModelStatus.Training] },
    deletedAt: null,
    userId,
  };

  const modelCategories = await getCategoryTags('model');
  const categoryIds = modelCategories.map((c) => c.id);

  try {
    const [models, count] = await dbRead.$transaction([
      dbRead.model.findMany({
        take,
        skip,
        where,
        select: {
          id: true,
          name: true,
        },
        orderBy: { name: 'asc' },
      }),
      dbRead.model.count({ where }),
    ]);
    const modelIds = models.map((m) => m.id);
    const modelTags = await modelTagCache.fetch(modelIds);
    const items = models.map((model) => ({
      ...model,
      tags: modelTags[model.id]?.tags.filter((x) => categoryIds.includes(x.id)) ?? [],
    }));

    return getPagingData({ items, count }, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const setModelsCategory = async ({
  categoryId,
  modelIds,
  userId,
}: SetModelsCategoryInput & {
  userId: number;
}) => {
  try {
    const modelCategories = await getCategoryTags('model');
    const category = modelCategories.find((c) => c.id === categoryId);
    if (!category) throw throwNotFoundError(`No category with id ${categoryId}`);

    const models = Prisma.join(modelIds);
    const allCategories = Prisma.join(modelCategories.map((c) => c.id));

    // Remove all categories from models
    await dbWrite.$executeRaw`
      DELETE
      FROM "TagsOnModels" tom
        USING "Model" m
      WHERE
          m.id = tom."modelId"
      AND m."userId" = ${userId}
      AND "modelId" IN (${models})
      AND "tagId" IN (${allCategories})
    `;

    // Add category to models
    await dbWrite.$executeRaw`
      INSERT INTO "TagsOnModels" ("modelId", "tagId")
      SELECT
        m.id,
        ${categoryId}
      FROM "Model" m
      WHERE
          m."userId" = ${userId}
      AND m.id IN (${models})
      ON CONFLICT ("modelId", "tagId") DO NOTHING;
    `;

    await modelTagCache.bust(modelIds);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

// #region [associated models]
export const getAssociatedResourcesSimple = async ({
  fromId,
  type,
}: GetAssociatedResourcesInput) => {
  const associations = await dbWrite.modelAssociations.findMany({
    where: { fromModelId: fromId, type },
    orderBy: { index: 'asc' },
    select: {
      id: true,
      toModel: {
        select: associatedResourceSelect,
      },
      toArticle: {
        select: { id: true, title: true, nsfwLevel: true, user: { select: simpleUserSelect } },
      },
    },
  });

  const items = associations
    .map(({ id, toModel, toArticle }) =>
      toModel
        ? { id, item: toModel, resourceType: 'model' as const }
        : toArticle
        ? { id, item: toArticle, resourceType: 'article' as const }
        : null
    )
    .filter(isDefined);

  return items;
};

export const setAssociatedResources = async (
  { fromId, type, associations }: SetAssociatedResourcesInput,
  user?: SessionUser
) => {
  const fromModel = await dbWrite.model.findUnique({
    where: { id: fromId },
    select: {
      userId: true,
      associations: {
        where: { type },
        select: { id: true },
        orderBy: { index: 'asc' },
      },
    },
  });

  if (!fromModel) throw throwNotFoundError();
  // only allow moderators or model owners to add/remove associated models
  if (!user?.isModerator && fromModel.userId !== user?.id) throw throwAuthorizationError();

  const existingAssociations = fromModel.associations.map((x) => x.id);
  const associationsToRemove = existingAssociations.filter(
    (existingToId) => !associations.find((item) => item.id === existingToId)
  );

  return await dbWrite.$transaction([
    // remove associated resources not included in payload
    dbWrite.modelAssociations.deleteMany({
      where: {
        fromModelId: fromId,
        type,
        id: { in: associationsToRemove },
      },
    }),
    // add or update associated models
    ...associations.map((association, index) => {
      const data =
        association.resourceType === 'model'
          ? { fromModelId: fromId, toModelId: association.resourceId, type }
          : { fromModelId: fromId, toArticleId: association.resourceId, type };

      return dbWrite.modelAssociations.upsert({
        where: { id: association.id ?? -1 },
        update: { index },
        create: { ...data, associatedById: user?.id, index },
      });
    }),
  ]);
};
// #endregion

export const getGallerySettingsByModelId = async ({ id }: GetByIdInput) => {
  const cacheKey = `${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${id}` as const;

  const cachedSettings = await redis.get(cacheKey);
  if (cachedSettings)
    return fromJson<ReturnType<typeof getGalleryHiddenPreferences>>(cachedSettings);

  const model = await getModel({
    id: id,
    select: { id: true, userId: true, gallerySettings: true },
  });
  if (!model) return null;

  const settings = model.gallerySettings
    ? await getGalleryHiddenPreferences({
        settings: model.gallerySettings as ModelGallerySettingsSchema,
      })
    : null;
  await redis.set(cacheKey, toJson(settings), { EX: CacheTTL.week });

  return settings;
};

export const getGalleryHiddenPreferences = async ({
  settings,
}: {
  settings: ModelGallerySettingsSchema;
}) => {
  const { tags, users, level, pinnedPosts = {}, hiddenImages = {} } = settings;
  const hiddenTags =
    tags && tags.length
      ? await dbRead.tag.findMany({
          where: { id: { in: tags } },
          select: { id: true, name: true },
        })
      : [];

  const hiddenUsers =
    users && users.length
      ? await dbRead.user.findMany({
          where: { id: { in: users } },
          select: { id: true, username: true },
        })
      : [];

  return {
    hiddenTags,
    hiddenUsers,
    hiddenImages,
    level: level ?? allBrowsingLevelsFlag,
    pinnedPosts,
  };
};

export async function getCheckpointGenerationCoverage(versionIds: number[]) {
  if (versionIds.length === 0) {
    return [];
  }

  const coveredResources = await dbRead.$queryRaw<{ version_id: number }[]>`
    SELECT
      version_id
    FROM "CoveredCheckpoint"
    WHERE
      version_id IN (${Prisma.join(versionIds)});
  `;

  return coveredResources.map((x) => x.version_id);
}

export async function isModelHashBlocked(sha256Hash: string) {
  const [{ blocked }] = await dbRead.$queryRaw<{ blocked: boolean }[]>`
    SELECT
      EXISTS (
        SELECT
          1
        FROM "BlockedModelHashes"
        WHERE
          hash = ${sha256Hash}
      ) as blocked;
  `;

  return blocked;
}

export async function refreshBlockedModelHashes() {
  await dbWrite.$executeRaw`
    REFRESH MATERIALIZED VIEW CONCURRENTLY "BlockedModelHashes";
  `;
}

export async function toggleCheckpointCoverage({ id, versionId }: ToggleCheckpointCoverageInput) {
  const affectedVersionIds = await dbWrite.$queryRaw<{ version_id: number }[]>`
    SELECT
      version_id
    FROM "CoveredCheckpoint"
         JOIN "ModelVersion" mv ON mv.id = version_id
    WHERE
      mv."modelId" = ${id};
  `;

  if (versionId) {
    if (affectedVersionIds.some((x) => x.version_id === versionId)) {
      await dbWrite.$executeRaw`
          DELETE
          FROM "CoveredCheckpoint"
          WHERE
            ("model_id" = ${id} AND "version_id" = ${versionId})
          OR ("model_id" = ${id} AND "version_id" IS NULL);
        `;
      affectedVersionIds.splice(
        affectedVersionIds.findIndex((x) => x.version_id === versionId),
        1
      );
    } else {
      await dbWrite.$executeRaw`
          INSERT INTO "CoveredCheckpoint" ("model_id", "version_id")
          VALUES
            (${id}, ${versionId})
          ON CONFLICT DO NOTHING;
        `;
      affectedVersionIds.push({ version_id: versionId });
    }
  }

  return affectedVersionIds.map((x) => x.version_id);
}

export async function getModelsWithVersions({
  input,
  user,
}: {
  input: GetAllModelsOutput & { take?: number; skip?: number };
  user?: {
    id: number;
    isModerator?: boolean;
    username?: string;
    filePreferences?: UserFilePreferences;
  };
}) {
  const { items, nextCursor } = await getModelsRaw({
    input,
    user,
    include: ['details'],
  });

  const modelVersionIds = items.flatMap(({ modelVersions }) => modelVersions.map(({ id }) => id));
  // Let's swap to the new cache based method for now...
  const images = await getImagesForModelVersionCache(modelVersionIds);
  // const images = await getImagesForModelVersion({
  //   modelVersionIds,
  //   imagesPerVersion: 10,
  //   include: [],
  //   excludedTagIds: input.excludedImageTagIds,
  //   excludedIds: await getHiddenImagesForUser({ userId: user?.id }),
  //   excludedUserIds: input.excludedUserIds,
  //   currentUserId: user?.id,
  // });

  const vaeIds = items
    .flatMap(({ modelVersions }) => modelVersions.map(({ vaeId }) => vaeId))
    .filter(isDefined);
  const vaeFiles = await getVaeFiles({ vaeIds });

  const groupedFiles = await getFilesForModelVersionCache(modelVersionIds);

  const modelIds = items.map(({ id }) => id);
  const metrics = await dbRead.modelMetric.findMany({
    where: { modelId: { in: modelIds }, timeframe: MetricTimeframe.AllTime },
  });

  const versionMetrics = await dbRead.modelVersionMetric.findMany({
    where: { modelVersionId: { in: modelVersionIds }, timeframe: MetricTimeframe.AllTime },
  });

  function getStatsForModel(modelId: number) {
    const stats = metrics.find((x) => x.modelId === modelId);
    return {
      downloadCount: stats?.downloadCount ?? 0,
      favoriteCount: 0,
      thumbsUpCount: stats?.thumbsUpCount ?? 0,
      thumbsDownCount: stats?.thumbsDownCount ?? 0,
      commentCount: stats?.commentCount ?? 0,
      ratingCount: 0,
      rating: 0,
      tippedAmountCount: stats?.tippedAmountCount ?? 0,
    };
  }

  function getStatsForVersion(versionId: number) {
    const stats = versionMetrics.find((x) => x.modelVersionId === versionId);
    return {
      downloadCount: stats?.downloadCount ?? 0,
      ratingCount: stats?.ratingCount ?? 0,
      rating: Number(stats?.rating?.toFixed(2) ?? 0),
      thumbsUpCount: stats?.thumbsUpCount ?? 0,
      thumbsDownCount: stats?.thumbsDownCount ?? 0,
    };
  }

  return {
    items: items.map(
      ({
        modelVersions,
        rank,
        hashes,
        earlyAccessDeadline,
        status,
        locked,
        publishedAt,
        createdAt,
        lastVersionAt,
        user,
        ...model
      }) => ({
        ...model,
        user: user.username === 'civitai' ? undefined : user,
        supportsGeneration: modelVersions.some((x) => x.covered),
        modelVersions: modelVersions.map(
          ({ trainingStatus, vaeId, earlyAccessTimeFrame, ...version }) => {
            const stats = getStatsForVersion(version.id);
            const vaeFile = vaeFiles.filter((x) => x.modelVersionId === vaeId);
            const files = groupedFiles[version.id]?.files ?? [];
            files.push(...vaeFile);

            let earlyAccessDeadline = getEarlyAccessDeadline({
              versionCreatedAt: version.createdAt,
              publishedAt: version.publishedAt,
              earlyAccessTimeframe: earlyAccessTimeFrame,
            });
            if (earlyAccessDeadline && new Date() > earlyAccessDeadline)
              earlyAccessDeadline = undefined;

            return {
              ...version,
              files: files.map(({ metadata: metadataRaw, modelVersionId, ...file }) => {
                const metadata = metadataRaw as FileMetadata | undefined;

                return {
                  ...file,
                  metadata: {
                    format: metadata?.format,
                    size: metadata?.size,
                    fp: metadata?.fp,
                  },
                };
              }),
              earlyAccessDeadline,
              stats,
              // images: images
              //   .filter((image) => image.modelVersionId === version.id)
              //   .map(
              //     ({ modelVersionId, name, userId, sizeKB, availability, metadata, ...image }) => ({
              //       ...image,
              //     })
              //   ),
              images: (images[version.id]?.images ?? []).map(
                ({
                  modelVersionId,
                  name,
                  userId,
                  sizeKB,
                  availability,
                  metadata,
                  tags,
                  ...image
                }) => ({
                  ...image,
                })
              ),
            };
          }
        ),
        stats: getStatsForModel(model.id),
      })
    ),
    nextCursor,
  };
}

export async function copyGallerySettingsToAllModelsByUser({
  settings,
  userId,
}: {
  settings: Pick<ModelGallerySettingsSchema, 'level' | 'users' | 'tags'>;
  userId: number;
}) {
  const result = await dbWrite.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { settings: true } });
    if (!user) throw throwNotFoundError(`No user with id ${userId}`);

    const userSettings = user.settings as UserSettingsSchema;

    await tx.user.update({
      where: { id: userId },
      data: {
        settings: {
          ...userSettings,
          gallerySettings: { ...userSettings.gallerySettings, ...settings },
        },
      },
    });
    await tx.$executeRaw`
      UPDATE "Model"
      SET "gallerySettings" = "gallerySettings" || jsonb_build_object(
        'level', ${settings.level},
        'users', ${JSON.stringify(settings.users || [])}::jsonb,
        'tags', ${JSON.stringify(settings.tags || [])}::jsonb
                                                   )
      WHERE
        "userId" = ${userId}
    `;

    await userContentOverviewCache.bust(userId);
  });

  const models = await dbWrite.model.findMany({ where: { userId }, select: { id: true } });
  const modelIds = models.map((x) => x.id);

  await Promise.all(modelIds.map((id) => redis.del(`${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${id}`)));
  return result;
}

export async function setModelShowcaseCollection({
  id,
  collectionId,
  userId,
  isModerator,
}: SetModelCollectionShowcaseInput & {
  userId: number;
  isModerator?: boolean;
}) {
  const model = await getModel({ id, select: { id: true, userId: true, meta: true } });
  if (!model) throw throwNotFoundError(`No model with id ${id}`);
  if (model.userId !== userId && !isModerator)
    throw throwAuthorizationError('You are not allowed to set this model collection showcase');

  const modelMeta = model.meta as ModelMeta | null;

  const updated = await updateModelById({
    id,
    data: {
      meta: modelMeta
        ? { ...modelMeta, showcaseCollectionId: collectionId }
        : { showcaseCollectionId: collectionId },
    },
  });

  await dataForModelsCache.bust(updated.id);

  return updated;
}

export async function migrateResourceToCollection({
  id: modelId,
  collectionName,
}: MigrateResourceToCollectionInput) {
  const model = await dbRead.model.findUnique({
    where: { id: modelId },
    include: { modelVersions: true, tagsOnModels: true, licenses: true, resourceReviews: true },
  });
  if (!model) throw throwNotFoundError('Model not found');
  if (model.status !== ModelStatus.Published) throw throwBadRequestError('Model must be published');
  if (model.locked || model.mode || model.tosViolation)
    throw throwBadRequestError(
      'Model cannot be locked, archived, taken down, or have a ToS violation'
    );

  const { id, modelVersions, tagsOnModels, licenses, resourceReviews, ...modelData } = model;
  const filteredVersions = modelVersions.filter((v) => v.status === ModelStatus.Published);
  if (filteredVersions.length <= 1)
    throw throwBadRequestError('Only models with more than one published version can be migrated');

  const { collection, modelIds } = await dbWrite.$transaction(
    async (tx) => {
      // Create the collection
      const collection = await tx.collection.create({
        data: {
          name: collectionName ?? model.name,
          userId: model.userId,
          type: 'Model',
          nsfw: model.nsfw || model.nsfwLevel >= nsfwBrowsingLevelsFlag,
          nsfwLevel: model.nsfwLevel,
          read: 'Public',
          write: 'Private',
          contributors: { create: { userId: model.userId, permissions: ['VIEW', 'ADD'] } },
          metadata: { originalModelId: model.id },
        },
      });

      const remainingVersions = filteredVersions.slice(1);

      // create a model for each remaining version
      const modelIds = [];
      for (const version of remainingVersions) {
        const newModel = await tx.model.create({
          data: {
            ...modelData,
            name: `${modelData.name} - ${version.name}`,
            meta: { ...((modelData.meta as ModelMeta) ?? {}), showcaseCollectionId: collection.id },
            gallerySettings:
              modelData.gallerySettings === null ? Prisma.JsonNull : modelData.gallerySettings,
            userId: modelData.userId,
            nsfwLevel: version.nsfwLevel,
            lastVersionAt: version.publishedAt,
            modelVersions: { connect: { id: version.id } },
            licenses: { create: licenses },
          },
          select: { id: true },
        });

        modelIds.push(newModel.id);

        const versionReviewIds = resourceReviews
          .filter((r) => r.modelVersionId === version.id)
          .map((r) => r.id);
        if (versionReviewIds.length > 0) {
          await tx.resourceReview.updateMany({
            where: { id: { in: versionReviewIds } },
            data: { modelId: newModel.id },
          });
        }
      }

      for (const modelId of modelIds) {
        // Add the tags to the models
        await tx.tagsOnModels.createMany({
          data: tagsOnModels.map((tag) => ({
            tagId: tag.tagId,
            modelId,
          })),
        });
      }

      // Add the models to the collection as collection items
      modelIds.push(model.id); // Include the original model
      await tx.collectionItem.createMany({
        data: modelIds.map((id) => ({
          collectionId: collection.id,
          modelId: id,
        })),
      });

      // update the original model name to include the version
      await tx.model.update({
        where: { id: model.id },
        data: { name: `${model.name} - ${filteredVersions[0].name}` },
      });

      return { collection, modelIds };
    },
    { timeout: 60000, maxWait: 10000 }
  );

  // Set the showcase collection for the original model
  await setModelShowcaseCollection({
    collectionId: collection.id,
    id: modelId,
    userId: model.userId,
  });

  // Bust caches
  await Promise.all([
    dataForModelsCache.bust(modelIds),
    bustMvCache(
      filteredVersions.map((v) => v.id),
      modelIds
    ),
  ]);

  modelMetrics
    .queueUpdate(modelIds)
    .catch((error) =>
      logToAxiom({ name: 'model-metrics', type: 'error', message: error.message, modelIds })
    );

  // Update search indexes
  await collectionsSearchIndex.queueUpdate([
    { id: collection.id, action: SearchIndexUpdateQueueAction.Update },
  ]);
  await modelsSearchIndex.queueUpdate(
    modelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
  );

  return { ok: true };
}

export async function ingestModelById({ id }: GetByIdInput) {
  const model = await dbRead.model.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      poi: true,
      nsfw: true,
      minor: true,
      sfwOnly: true,
    },
  });
  if (!model) throw new TRPCError({ code: 'NOT_FOUND' });

  const parsedModel = ingestModelSchema.parse(model);
  return await ingestModel({ ...parsedModel });
}

export async function ingestModel(data: IngestModelInput) {
  if (!env.CONTENT_SCAN_ENDPOINT) {
    console.log('Skipping model ingestion');
    await dbWrite.model.update({
      where: { id: data.id },
      data: { scannedAt: new Date() },
    });
    return true;
  }

  // get version data
  const db = await getDbWithoutLag('modelVersion');
  const versions = await db.modelVersion.findMany({
    where: { modelId: data.id, status: { in: [ModelStatus.Published, ModelStatus.Scheduled] } },
    select: { description: true, trainedWords: true },
  });

  const versionDescriptions = versions.map((x) => x.description || null).filter(isDefined);
  const triggerWords = versions.flatMap((x) => x.trainedWords);

  const payload = {
    callbackUrl:
      env.CONTENT_SCAN_CALLBACK_URL ??
      `${env.NEXTAUTH_URL}/api/webhooks/model-scan-result?token=${env.WEBHOOK_TOKEN}`,
    request: {
      llm_model: env.CONTENT_SCAN_MODEL ?? 'gpt-4o-mini',
      content: {
        id: data.id,
        name: data.name,
        content: [data.description, ...versionDescriptions].join('\n'),
        POI: data.poi,
        NSFW: data.nsfw,
        minor: data.minor,
        sfwOnly: data.sfwOnly,
        triggerwords: triggerWords,
      },
    },
  };

  const response = await fetch(`${env.CONTENT_SCAN_ENDPOINT}/scan_model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Failed to scan model. Service is unavailable.',
    });

  if (response.status === 202) return true;
  else return false;
}

export type GetFeaturedModels = AsyncReturnType<typeof getFeaturedModels>;
export async function getFeaturedModels() {
  try {
    return await fetchThroughCache(REDIS_KEYS.CACHES.FEATURED_MODELS, async () => {
      // was trying to subtract 2 minutes
      const now = dayjs();

      // TODO we're featuring modelVersions, but showing models due to how collections and meili works

      let retries = 0;
      while (retries < 3) {
        const nowDate = now.subtract(retries, 'day').toDate();
        const data = await dbRead.featuredModelVersion.findMany({
          where: {
            validFrom: { lte: nowDate },
            validTo: { gt: nowDate },
          },
          select: {
            position: true,
            modelVersion: {
              select: { modelId: true },
            },
          },
          orderBy: { position: 'asc' },
        });
        if (data.length === 0) {
          retries++;
        } else {
          return [
            ...data
              .reduce((map, row) => {
                const current = map.get(row.modelVersion.modelId);
                if (!current || row.position < current.position) {
                  map.set(row.modelVersion.modelId, {
                    modelId: row.modelVersion.modelId,
                    position: row.position,
                  });
                }
                return map;
              }, new Map<number, { modelId: number; position: number }>())
              .values(),
          ];
        }
      }

      // if nothing found, get from the collection
      const query = await dbWrite.$queryRaw<{ modelId: number }[]>`
        SELECT
          ci."modelId"
        FROM "CollectionItem" ci
        WHERE
          ci."collectionId" = ${FEATURED_MODEL_COLLECTION_ID}
        ORDER BY "createdAt" desc
        LIMIT 500
      `;
      return query.map((row) => ({ modelId: row.modelId, position: 0 }));
    });
  } catch (e) {
    const error = e as Error;
    logToAxiom({
      name: 'featured-models',
      type: 'error',
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    }).catch();
    return [];
  }
}

export async function bustFeaturedModelsCache() {
  await bustFetchThroughCache(REDIS_KEYS.CACHES.FEATURED_MODELS);
}

export async function getModelModRules() {
  const modRules = await fetchThroughCache(
    REDIS_KEYS.CACHES.MOD_RULES.MODELS,
    async () => {
      const rules = await dbRead.moderationRule.findMany({
        where: { entityType: EntityType.Model, enabled: true },
        select: { id: true, definition: true, action: true, reason: true },
        orderBy: [{ order: 'asc' }],
      });

      return rules.map(({ definition, ...rule }) => ({
        ...rule,
        definition: definition as RuleDefinition,
      }));
    },
    { ttl: CacheTTL.day }
  );

  return modRules;
}

export async function bustModelModRulesCache() {
  await bustFetchThroughCache(REDIS_KEYS.CACHES.MOD_RULES.MODELS);
}

export const getPrivateModelCount = async ({ userId }: { userId: number }) => {
  return await dbRead.model.count({
    where: { userId, availability: Availability.Private },
  });
};

export const privateModelFromTraining = async ({
  modelVersionIds,
  ...input
}: PrivateModelFromTrainingInput & {
  user: SessionUser; // @luis: Against this personally, but the way createPostImage is implemented requires this.
}) => {
  if (!input.user.isModerator) {
    for (const key of input.lockedProperties ?? []) delete input[key as keyof typeof input];
  }

  const { id, tagsOnModels, user, templateId, bountyId, meta, status, ...data } = input;

  const totalPrivateModels = await dbRead.model.count({
    where: {
      userId: input.user.id,
      availability: Availability.Private,
      status: ModelStatus.Published,
    },
  });

  const subscription = await getUserSubscription({ userId: input.user.id });

  const maxPrivateModels = subscription?.tier
    ? constants.memberships.membershipDetailsAddons[
        subscription.tier as keyof typeof constants.memberships.membershipDetailsAddons
      ]?.maxPrivateModels ?? 0
    : 0;

  if (totalPrivateModels >= maxPrivateModels) {
    throw throwBadRequestError('You have reached the maximum number of private models');
  }

  // don't allow updating of locked properties
  if (!user.isModerator) {
    const lockedProperties = data.lockedProperties ?? [];
    for (const prop of lockedProperties) {
      const key = prop as keyof typeof data;
      if (data[key] !== undefined) delete data[key];
    }
  }

  const model = await dbRead.model.findUnique({
    where: { id },
    select: {
      userId: true,
    },
  });

  if (!model) return null;

  const isOwner = model.userId === user.id || user.isModerator;
  if (!isOwner) return null;

  try {
    const result = await dbWrite.model.update({
      select: {
        id: true,
        name: true,
        description: true,
        nsfwLevel: true,
        poi: true,
        minor: true,
        sfwOnly: true,
        nsfw: true,
        gallerySettings: true,
        status: true,
        meta: true,
        modelVersions: {
          where: modelVersionIds
            ? {
                id: {
                  in: modelVersionIds,
                },
              }
            : undefined,
          select: {
            id: true,
          },
        },
      },
      where: { id },
      data: {
        ...data,
        availability: Availability.Private,
        status: ModelStatus.Published,
      },
    });

    await dbWrite.modelVersion.updateMany({
      where: { modelId: id },
      data: {
        // Ensures things don't break by leaving some versions public.
        // @luis: TODO: Might be smart to add some DB triggers for this.
        availability: Availability.Private,
      },
    });

    if (result.modelVersions.length > 0) {
      const now = new Date();
      // Make this private:
      await dbWrite.modelVersion.updateMany({
        where: { id: { in: result.modelVersions.map((x) => x.id) } },
        data: {
          availability: Availability.Private,
          publishedAt: now,
          status: ModelStatus.Published,
        },
      });

      // Create posts:
      await Promise.all(
        result.modelVersions.map(async (modelVersion) => {
          await createModelVersionPostFromTraining({
            modelVersionId: modelVersion.id,
            user,
          });
        })
      );
    }

    await preventReplicationLag('model', id);
    await userContentOverviewCache.bust(user.id);
    await dataForModelsCache.bust(id);
    await bustMvCache(
      result.modelVersions.map((x) => x.id),
      result.id
    );

    return result;
  } catch (error) {
    await dbWrite.model.update({
      where: { id },
      data: { status: ModelStatus.Draft, availability: Availability.Public },
    });

    await dbWrite.modelVersion.updateMany({
      where: { modelId: id },
      data: { status: ModelStatus.Draft, publishedAt: null },
    });

    throw throwDbError(error);
  }
};

export const publishPrivateModel = async ({
  modelId,
  publishVersions,
}: PublishPrivateModelInput) => {
  const versions = await dbRead.modelVersion.findMany({
    where: { modelId, status: ModelStatus.Published },
    select: { id: true },
  });

  if (!versions.length) {
    throw throwBadRequestError('Model has no published versions');
  }

  const versionIds = versions.map((v) => v.id);
  const now = new Date();

  await dbWrite.$transaction([
    dbWrite.post.updateMany({
      where: {
        modelVersionId: { in: versionIds },
      },
      data: {
        publishedAt: publishVersions ? now : null,
        availability: Availability.Public,
      },
    }),
    dbWrite.modelVersion.updateMany({
      where: { id: { in: versionIds } },
      data: {
        availability: Availability.Public,
        status: publishVersions ? ModelStatus.Published : ModelStatus.Draft,
        publishedAt: publishVersions ? now : null,
      },
    }),
    dbWrite.model.update({
      where: {
        id: modelId,
      },
      data: {
        availability: Availability.Public,
        status: publishVersions ? ModelStatus.Published : ModelStatus.Unpublished,
        publishedAt: publishVersions ? now : null,
      },
    }),
  ]);

  const updatedImageIds = await dbRead.image.findMany({
    where: {
      post: {
        modelVersionId: { in: versionIds },
      },
    },
  });

  if (updatedImageIds.length > 0) {
    await imagesMetricsSearchIndex.queueUpdate(
      updatedImageIds.map((x) => ({ id: x.id, action: SearchIndexUpdateQueueAction.Update }))
    );
  }

  return { versionIds };
};

export const toggleCannotPromote = async ({
  id,
  isModerator,
}: GetByIdInput & {
  isModerator: boolean;
}) => {
  if (!isModerator) throw throwAuthorizationError();

  const model = await getModel({ id, select: { id: true, meta: true } });
  if (!model) throw throwNotFoundError(`No model with id ${id}`);

  const modelMeta = model.meta as ModelMeta | null;
  const currentCannotPromote = modelMeta?.cannotPromote ?? false;
  const cannotPromote = !currentCannotPromote;

  const updated = await dbWrite.model.update({
    where: { id },
    data: {
      meta: modelMeta ? { ...modelMeta, cannotPromote } : { cannotPromote },
    },
    select: { id: true, meta: true },
  });

  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

  if (cannotPromote) {
    await deleteBidsForModel({ modelId: id });
  }

  return {
    id: updated.id,
    meta: updated.meta as ModelMeta | null,
  };
};

export async function getTopWeeklyEarners(fresh = false) {
  if (fresh) await bustFetchThroughCache(REDIS_KEYS.CACHES.TOP_EARNERS);

  const results = await fetchThroughCache(
    REDIS_KEYS.CACHES.TOP_EARNERS,
    async () => {
      const auctionReset = await getLastAuctionReset();
      if (!auctionReset) return [];

      const topEarners = await clickhouse!.$query<{ modelVersionId: number; earned: number }>`
        SELECT
        modelVersionId,
        cast(SUM(total) as int) as earned
        FROM buzz_resource_compensation
        WHERE date >= toStartOfDay(${auctionReset}::Date)
        GROUP BY modelVersionId
        ORDER BY earned DESC
        LIMIT 100;
      `;
      const asArray = topEarners.map((x) => [x.modelVersionId, x.earned] as const);
      const json = JSON.stringify(asArray);

      const data = await dbWrite.$queryRawUnsafe<
        { modelId: number; modelVersionId: number; earnedAmount: number }[]
      >(`
        WITH input_data AS (
          SELECT
            (value->>0)::INT AS modelVersionId,
            (value->>1)::INT AS earned
          FROM jsonb_array_elements('${json}'::jsonb) AS arr(value)
        )
        SELECT
          m.id as "modelId",
          mv.id as "modelVersionId",
          i.earned as "earnedAmount"
        FROM input_data i
        JOIN "ModelVersion" mv ON mv.id = i.modelVersionId
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE
          m.type = 'Checkpoint'
          AND mv.id NOT IN (SELECT id FROM "EcosystemCheckpoints")
        ORDER BY i.earned DESC
        LIMIT 100;
      `);
      return data;
    },
    { ttl: CacheTTL.day }
  );
  // TODO: fetch additional details about these models as needed, we just don't need to catch all that data...
  // If it's expensive/slow, feel free to throw it in the cache instead...

  return results;
}
