import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type { ManipulateType } from 'dayjs';
import { isEmpty, uniq } from 'lodash-es';
import dayjs from '~/shared/utils/dayjs';
import type { SearchParams, SearchResponse } from 'meilisearch';
import type { SessionUser } from '~/types/session';
import { clickhouse, Tracker } from '~/server/clickhouse/client';
import type { BaseModelType } from '~/server/common/constants';
import {
  CacheTTL,
  constants,
  FEATURED_MODEL_COLLECTION_ID,
  MODELS_SEARCH_INDEX,
  nsfwRestrictedBaseModels,
} from '~/server/common/constants';
import {
  type BaseModel,
  DEPRECATED_BASE_MODELS,
  isBaseModelGenerationSupported,
} from '~/shared/constants/basemodel.constants';
import { ModelSort, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { toApiModelFile } from '~/server/common/model-helpers';
import type { Context } from '~/server/createContext';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  getDbWithoutLag,
  preventModelVersionLagBatch,
  preventReplicationLag,
} from '~/server/db/db-lag-helpers';
import { createProfanityFilter } from '~/libs/profanity-simple';
import { isFlipt } from '~/server/flipt/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import {
  isTransientMeiliError,
  MeiliCallTimeoutError,
  searchClient,
  withMeili,
} from '~/server/meilisearch/client';
import { modelMetrics } from '~/server/metrics';
import { withSpan } from '~/server/utils/otel-helpers';
import {
  diffEntityChanges,
  resolveActorRole,
  stableStringify,
} from '~/server/utils/entity-change-helpers';
import {
  dataForModelsCache,
  modelTagCache,
  modelVersionPublicDonationGoalsCache,
  modelVotableTagsCache,
  userBasicCache,
  userModelCountCache,
} from '~/server/redis/caches';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import type { ModelVersionMeta } from '~/server/schema/model-version.schema';
import type {
  GetAllModelsOutput,
  GetModelVersionsSchema,
  GetMyTrainingModelsSchema,
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
  SetModelMinorInput,
  SetModelSfwOnlyInput,
  SetModelOfficialInput,
  ToggleCheckpointCoverageInput,
  ToggleModelLockInput,
  TransferModelOwnershipInput,
  UnpublishModelSchema,
} from '~/server/schema/model.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
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
import { evaluateAutoNsfw } from '~/server/services/auto-nsfw';
import { deleteBidsForModel, getLastAuctionReset } from '~/server/services/auction.service';
import { enforceBlockedBrowsingTagsForModels } from '~/server/services/blocked-browsing-tags.service';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { getNewCreatorUserIds } from '~/server/services/new-creators.service';
import {
  getAvailableCollectionItemsFilterForUser,
  getUserCollectionPermissionsById,
  saveItemInCollections,
} from '~/server/services/collection.service';
import {
  enqueueCollectionRebuild,
  getCollectionIdsForModelCascade,
} from '~/server/services/collection-media-index';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import type { ImagesForModelVersions } from '~/server/services/image.service';
import {
  getImagesForModelVersion,
  getImagesForModelVersionCache,
  queueImageSearchIndexUpdate,
} from '~/server/services/image.service';
import { getFilesForModelVersionCache } from '~/server/services/model-file.service';
import { buildRepublishImageIndexTouch } from '~/server/services/model-republish-image-index.sql';
import {
  expandBlurbs,
  getReferencedBlurbIds,
  reconcileBlurbReferences,
} from '~/server/services/blurb-materialize.service';
import { submitModelTextModeration } from '~/server/services/model-moderation.adapter';
import {
  bustMvCache,
  bustPublicModelResponseCache,
  createModelVersionPostFromTraining,
  publishModelVersionsWithEarlyAccess,
} from '~/server/services/model-version.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { getHighestTierSubscription } from '~/server/services/subscriptions.service';
import { getCategoryTags } from '~/server/services/system-cache';
import {
  bustUserSettings,
  deleteBasicDataForUser,
  getCosmeticsForUsers,
  getProfilePicturesForUsers,
  patchUserSettings,
} from '~/server/services/user.service';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  anyMetricHidden,
  gateHiddenMetrics,
  getMetaMetricPrivacy,
  getUserMetricPrivacyDefaults,
  resolveModelHiddenMetrics,
  resolveVersionHiddenMetrics,
  type HiddenModelMetrics,
} from '~/server/utils/model-metric-privacy';
import {
  getValidCreatorMembershipMap,
  getUserMetricPrivacyDefaultsMap,
} from '~/server/services/creator-program.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { enforceLockedProperties } from '~/server/utils/locked-properties';
import { stripMinorHashMeta, stripModerationOwnedMeta } from '~/server/utils/minor-flag-meta';
import type { RuleDefinition } from '~/server/utils/mod-rules';
import {
  buildGetAllModelImages,
  GET_ALL_IMAGES_PER_MODEL,
} from '~/server/utils/model-getall-images';
import {
  DEFAULT_PAGE_SIZE,
  getCursorClauses,
  getPagination,
  getPagingData,
} from '~/server/utils/pagination-helpers';
import {
  allBrowsingLevelsFlag,
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { CommercialUse, DomainColor, ModelType } from '~/shared/utils/prisma/enums';
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
import { decreaseDate } from '~/utils/date-helpers';
import { isPaidAccessActive } from '@civitai/buzz';
import {
  bustPaidAccessCache,
  getPaidAccess,
  getPublicPaidAccessForModelVersions,
} from '~/server/services/paid-access.service';
import { prepareFile } from '~/utils/file-helpers';
import { fromJson, toJson } from '~/utils/json-helpers';
import { deleteModelFileObjects } from '~/utils/s3-utils';
import { deregisterFileLocationsBatch } from '~/utils/storage-resolver';
import { isDefined } from '~/utils/type-guards';
import type {
  GetAssociatedResourcesInput,
  GetModelsWithCategoriesSchema,
  SetAssociatedResourcesInput,
  SetModelsCategoryInput,
} from './../schema/model.schema';
import { Flags } from '~/shared/utils/flags';
import { isGenerationDisabled } from '~/shared/constants/model-version-flags.constants';
import { pgDbRead } from '~/server/db/pgDb';

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
  meta?: ModelMeta | null;
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
  earlyAccessDeadline: Date | null;
  mode: string;
  rank: {
    downloadCount: number;
    thumbsUpCount: number;
    thumbsDownCount: number;
    commentCount: number;
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
    publishedAt: Date | null;
    status: ModelStatus;
    covered: boolean;
    flags: number;
  }[];
  userId: number;
  cosmetic?: WithClaimKey<ContentDecorationCosmetic> | null;
  availability?: Availability;
};

/**
 * IMPORTANT: When modifying filters in this function, ensure both query paths
 * (standard ModelMetric and ModelBaseModelMetric) apply the same filters.
 * The base model metrics path (when useBaseModelMetrics=true) combines mbmAND and AND arrays.
 *
 * Test endpoint: GET /api/internal/test-model-feed-filters?token=<JOB_TOKEN>
 * Run after changes to verify filters work correctly with baseModel filtering.
 */

export async function getModelEarlyAccessDeadlines(modelIds: number[]): Promise<Map<number, Date>> {
  if (!modelIds.length) return new Map();
  const rows = await dbRead.$queryRaw<{ modelId: number; deadline: Date }[]>`
    SELECT mv."modelId", MAX(pa."endsAt") AS deadline
    FROM "PaidAccess" pa
    JOIN "ModelVersion" mv ON mv.id = pa."entityId"
    WHERE pa."entityType" = 'ModelVersion' AND pa."endsAt" > NOW()
      AND mv.status = 'Published'::"ModelStatus"
      AND mv."modelId" IN (${Prisma.join(modelIds)})
    GROUP BY mv."modelId"
  `;
  return new Map(rows.map((r) => [Number(r.modelId), r.deadline]));
}

export async function getActiveEarlyAccessModelIds(): Promise<number[]> {
  const rows = await dbRead.$queryRaw<{ modelId: number }[]>`
    SELECT DISTINCT mv."modelId"
    FROM "PaidAccess" pa
    JOIN "ModelVersion" mv ON mv.id = pa."entityId"
    WHERE pa."entityType" = 'ModelVersion' AND pa."endsAt" > NOW()
      AND mv.status = 'Published'::"ModelStatus"
  `;
  return rows.map((r) => Number(r.modelId));
}

// Permanent gates only. `timeframeDays IS NULL` is the discriminator, not `endsAt`:
// a timed gate carries a NULL `endsAt` until it is materialized at publish, so
// keying off `endsAt` would sweep in pending early access. The rule is owned by
// `paid-access.service.ts` — change it there and here together.
export async function getPermanentPaidAccessModelIds(): Promise<number[]> {
  const rows = await dbRead.$queryRaw<{ modelId: number }[]>`
    SELECT DISTINCT mv."modelId"
    FROM "PaidAccess" pa
    JOIN "ModelVersion" mv ON mv.id = pa."entityId"
    WHERE pa."entityType" = 'ModelVersion' AND pa."timeframeDays" IS NULL
      AND mv.status = 'Published'::"ModelStatus"
  `;
  return rows.map((r) => Number(r.modelId));
}

export const getModelsRaw = async ({
  input,
  include,
  user: sessionUser,
  domain,
  ignoreBrowsingAddons,
  _forceBaseModelMetrics,
}: {
  input: Omit<GetAllModelsOutput, 'limit' | 'page'> & {
    take?: number;
    skip?: number;
  };
  // Request color, used to pick which "new & upcoming" board backs `newCreators`.
  domain?: DomainColor;
  include?: Array<'details' | 'cosmetics'>;
  user?: { id: number; isModerator?: boolean; username?: string };
  /**
   * Drop the addon-derived discovery exclusions — for by-id lookups, whose
   * `browsingLevel` is a permission ceiling rather than viewer intent.
   * Deliberately a sibling of `input` (not a field on it) so it can never arrive
   * from parsed query params.
   */
  ignoreBrowsingAddons?: boolean;
  /** For testing only: force the ModelBaseModelMetric query path regardless of feature flag */
  _forceBaseModelMetrics?: boolean;
}) => {
  // Ahead of every early empty return below, including the Meilisearch no-hits one: the point of
  // throwing rather than falling back is that the misuse is legible, and an empty page hides it.
  if (input.sort === ModelSort.RecentlyAdded && !input.collectionId) {
    throw throwBadRequestError('Recently Added sort requires a collectionId');
  }

  const blockedEnforcement = await enforceBlockedBrowsingTagsForModels(
    input,
    {
      id: sessionUser?.id,
      username: sessionUser?.username,
      isModerator: sessionUser?.isModerator,
    },
    { ignoreBrowsingAddons }
  );
  if (blockedEnforcement.emptyResult) return { items: [], isPrivate: false };

  const {
    user,
    take,
    cursor,
    query,
    followed,
    newCreators,
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
    paidAccess,
    onSale,
    supportsGeneration,
    fromPlatform,
    needsReview,
    collectionId,
    fileFormats,
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
  if (query && searchClient && (!ids || ids.length === 0)) {
    const request: SearchParams = {
      limit: take ?? 100,
      filter: [
        browsingLevel
          ? `nsfwLevel IN [${Flags.instanceToArray(browsingLevel).join(',')}]`
          : undefined,
      ].filter(isDefined),
    };

    // Wrap the SDK call under withMeili('search', ...) so a backend brownout
    // is bounded by MEILI_CALL_TIMEOUT_MS instead of bleeding the event loop
    // until Traefik's 30s router timeout — same cascade pattern that bit
    // image.getInfinite (PR #2351). Translate the timeout to a TRPCError
    // TIMEOUT here (vs at each controller) so every getModelsRaw caller
    // — models.getAll, recommenders, associated-resources, etc. — fails fast
    // with a 408 instead of hanging on a slow Meili.
    // searchClient was null-checked on the outer if; pin a local non-null
    // reference so TS narrowing survives the closure boundary.
    const client = searchClient;
    let results: SearchResponse<ModelSearchIndexRecord>;
    try {
      results = await withMeili('search', () =>
        client.index(MODELS_SEARCH_INDEX).search(query, request)
      );
    } catch (err) {
      // Widened from `instanceof MeiliCallTimeoutError` to isTransientMeiliError
      // (same fix as /api/v1/models' resolveModelSearchIds + #2972's user
      // search). getModelsRaw is the search path behind model.getAll (the tRPC
      // getModelsInfiniteHandler); its timeout-wrapper only caught civitai's own
      // MeiliCallTimeoutError. A Meilisearch brownout ALSO throws the SDK's own
      // transient types (MeiliSearchCommunicationError 408/429/5xx,
      // MeiliSearchApiError gateway 502/503/504, network ECONNRESET, …), which
      // fell through `throw err` → getModelsInfiniteHandler's throwDbError
      // wrapped them as TRPCError INTERNAL_SERVER_ERROR → a 500 (invisible in
      // Axiom). Converting them to SERVICE_UNAVAILABLE here surfaces a transient
      // brownout as a retryable 503 through getModelsInfiniteHandler's
      // `if (error instanceof TRPCError) throw error` (which re-throws it
      // unchanged). Non-transient errors (malformed filter / auth / real app
      // bug) are NOT matched and still surface as their real status.
      if (isTransientMeiliError(err)) {
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Model search is temporarily overloaded — please retry.',
          cause: err,
        });
      }
      throw err;
    }

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
  let collectionJoin = Prisma.empty;

  const userId = sessionUser?.id;
  const isModerator = sessionUser?.isModerator ?? false;

  // Determine which query path to use for base model filtering
  // When using base model metrics, we JOIN ModelBaseModelMetric and use mbm.* for denormalized fields
  const useBaseModelMetrics =
    baseModels?.length && (_forceBaseModelMetrics ?? (await isFlipt('base-model-feed-metrics')));

  // Multi-baseModel + Newest/Oldest sort gets a special path: the legacy aggregate
  // subquery scans every "ModelBaseModelMetric" row matching the requested base
  // models BEFORE the cursor predicate can be applied (since the cursor lives on
  // mm."lastVersionAt"). On production this is ~2.8s/query at deep cursors. The
  // new path drives from "ModelMetric" using the feed_newest / feed_oldest
  // covering index, semi-joins to "ModelBaseModelMetric" via EXISTS, and pulls
  // the per-base-model rank sums via LATERAL aggregate that fires only for the
  // LIMIT survivors.
  const useNewestOldestMultiBmPath =
    !!useBaseModelMetrics &&
    (baseModels?.length ?? 0) > 1 &&
    (sort === ModelSort.Newest || sort === ModelSort.Oldest);

  // Dynamic alias: 'mbm' for ModelBaseModelMetric path, 'mm' for standard ModelMetric path
  // pSql is used for columns denormalized on both tables (status, nsfwLevel, availability, mode, minor, poi)
  // mm.* is still used for ModelMetric-only columns (userId, lastVersionAt, commentCount, collectedCount, etc.)
  //
  // The newest/oldest multi-bm path drives from mm and only references mbm for the
  // per-base-model rank sums (downloadCount, thumbsUpCount). All other denormalized
  // columns come from mm so the feed_newest/feed_oldest covering index is fully
  // exploited (filters are applied during the index scan, not after).
  const pAlias = useBaseModelMetrics && !useNewestOldestMultiBmPath ? 'mbm' : 'mm';
  const pSql = Prisma.raw(pAlias);

  // For the SELECT-list rank fields, the per-base-model sums must come from mbm
  // (the ModelBaseModelMetric driver in the legacy paths, or the LATERAL alias in
  // the new path). Other paths can keep using `${pSql}` directly.
  const rankPSql = useNewestOldestMultiBmPath ? Prisma.raw('mbm') : pSql;

  if (searchModelIds.length) {
    AND.push(Prisma.sql`mm."modelId" IN (${Prisma.join(searchModelIds, ',')})`);
  }

  const hidePrivateModels = !ids && !username && !user && !followed && !collectionId;

  if (!archived) {
    AND.push(
      Prisma.sql`(${pSql}."mode" IS NULL OR ${pSql}."mode" != ${ModelModifier.Archived}::"ModelModifier")`
    );
  }

  if (disablePoi) {
    AND.push(Prisma.sql`(${pSql}."poi" = false OR mm."userId" = ${userId})`);
  }
  if (disableMinor) {
    AND.push(Prisma.sql`${pSql}."minor" = false`);
  }
  if (input.excludedTagIds?.length) {
    const notExcluded = Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "TagsOnModels" tom
      WHERE tom."modelId" = m."id"
        AND tom."tagId" IN (${Prisma.join([...new Set(input.excludedTagIds)])})
    )`;
    AND.push(userId ? Prisma.sql`(${notExcluded} OR m."userId" = ${userId})` : notExcluded);
  }

  if (isModerator) {
    if (poiOnly) {
      AND.push(Prisma.sql`${pSql}."poi" = true`);
    }
    if (minorOnly) {
      AND.push(Prisma.sql`${pSql}."minor" = true`);
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
    const userFindArgs = { where: { username: (username || user) ?? '' }, select: { id: true } };
    const targetUser =
      (await dbRead.user.findUnique(userFindArgs)) ?? (await dbWrite.user.findUnique(userFindArgs));

    if (!targetUser) throw throwNotFoundError('User not found');

    AND.push(Prisma.sql`mm."userId" = ${targetUser.id}`);
  }

  if (types?.length) {
    AND.push(Prisma.sql`m.type = ANY(ARRAY[${Prisma.join(types)}]::"ModelType"[])`);
  }

  if (hidden && sessionUser?.id) {
    AND.push(
      Prisma.sql`EXISTS (
          SELECT 1 FROM "ModelEngagement" e
          WHERE e."modelId" = mm."modelId" AND e."userId" = ${sessionUser?.id} AND e."type" = 'Hide'::"ModelEngagementType")
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
      AND.push(Prisma.sql`mm."userId" IN (${Prisma.join(followedUsersIds, ',')})`);
    }

    isPrivate = true;
  }

  // Creators on the "new & upcoming" board. Global per domain rather than per
  // viewer, so unlike `followed` it doesn't mark the query private. An unpopulated
  // board returns nothing rather than degrading to the unfiltered feed.
  if (newCreators) {
    const newCreatorIds = await getNewCreatorUserIds({ entity: 'models', domain });
    AND.push(
      newCreatorIds.length
        ? Prisma.sql`mm."userId" IN (${Prisma.join(newCreatorIds, ',')})`
        : Prisma.sql`1 = 0`
    );
  }

  // Base model filtering:
  // - Standard path: EXISTS subquery on ModelVersion
  // - Base model metrics, single base model: direct equality on mbm."baseModel" (preserves index scan)
  // - Base model metrics, multiple base models, Newest/Oldest sort: EXISTS semi-join
  //   on ModelBaseModelMetric (planner-friendly, lets feed_newest/feed_oldest drive)
  // - Base model metrics, multiple base models, per-base-model-stat sort: filter is
  //   inside the FROM subquery (see fromClause)
  if (baseModels?.length && !useBaseModelMetrics) {
    AND.push(
      Prisma.sql`EXISTS (
          SELECT 1 FROM "ModelVersion" mv
          WHERE mv."modelId" = m."id"
            AND mv."baseModel" IN (${Prisma.join(baseModels, ',')})
        )`
    );
  } else if (useBaseModelMetrics && baseModels!.length === 1) {
    // Single base model: filter in WHERE clause so covering indexes can be fully utilized
    AND.push(Prisma.sql`mbm."baseModel" = ${baseModels![0]}`);
  } else if (useNewestOldestMultiBmPath) {
    // Multi-base-model + lastVersionAt sort: semi-join via EXISTS so the planner
    // keeps the feed_newest/feed_oldest index as the driver. The PK on
    // (modelId, baseModel) makes this lookup index-only.
    AND.push(
      Prisma.sql`EXISTS (
          SELECT 1 FROM "ModelBaseModelMetric" mbmm
          WHERE mbmm."modelId" = mm."modelId"
            AND mbmm."baseModel" IN (${Prisma.join(baseModels!, ',')})
        )`
    );
  }

  if (period && period !== MetricTimeframe.AllTime && periodMode !== 'stats') {
    AND.push(
      Prisma.sql`(mm."lastVersionAt" >= ${decreaseDate(
        new Date(),
        1,
        period.toLowerCase() as ManipulateType
      )})`
    );
  }
  // If the user is not a moderator, only show published models
  if (!sessionUser?.isModerator || !status?.length) {
    AND.push(Prisma.sql`${pSql}."status" = ${ModelStatus.Published}::"ModelStatus"`);
  } else if (sessionUser?.isModerator) {
    if (status?.includes(ModelStatus.Unpublished)) status.push(ModelStatus.UnpublishedViolation);
    AND.push(
      Prisma.sql`${pSql}."status" IN (${Prisma.raw(
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

  if (!!ids?.length) AND.push(Prisma.sql`mm."modelId" IN (${Prisma.join(ids, ',')})`);

  if (!!modelVersionIds?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ModelVersion" mv
      WHERE mv."id" IN (${Prisma.join(modelVersionIds, ',')})
        AND mv."modelId" = mm."modelId"
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
    AND.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "PaidAccess" pa
        JOIN "ModelVersion" pamv ON pamv.id = pa."entityId"
        WHERE pa."entityType" = 'ModelVersion' AND pamv."modelId" = m.id
          AND pamv.status = 'Published'::"ModelStatus" AND pa."endsAt" > NOW()
      )`
    );
  }
  if (paidAccess) {
    AND.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "PaidAccess" pa
        JOIN "ModelVersion" pamv ON pamv.id = pa."entityId"
        WHERE pa."entityType" = 'ModelVersion' AND pamv."modelId" = m.id
          AND pamv.status = 'Published'::"ModelStatus" AND pa."timeframeDays" IS NULL
      )`
    );
  }
  if (onSale) {
    // A sale prices a PERMANENT gate only (timeframeDays IS NULL), matching the resolver — a version in a
    // timed early-access window is never discounted, so listing it as on sale would be a lie the price
    // page then contradicts. Ownership is re-checked here for the same reason the resolver does it: sales
    // are authored in another application.
    AND.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "ModelVersionSaleItem" si
        JOIN "ModelVersionSale" s ON s.id = si."saleId"
        JOIN "ModelVersion" smv ON smv.id = si."modelVersionId"
        JOIN "PaidAccess" spa ON spa."entityType" = 'ModelVersion' AND spa."entityId" = smv.id
        WHERE smv."modelId" = m.id
          AND smv.status = 'Published'::"ModelStatus"
          AND spa."timeframeDays" IS NULL
          AND s."userId" = m."userId"
          AND s."startsAt" <= NOW() AND s."endsAt" > NOW()
          AND (s."canceledAt" IS NULL OR s."canceledAt" > NOW())
      )`
    );
  }
  if (availability) {
    if (availability === Availability.Private && !(username || isModerator)) {
      throw throwAuthorizationError();
    }

    AND.push(Prisma.sql`${pSql}."availability" = ${availability}::"Availability"`);
  } else if (!isModerator) {
    // Makes it so that our feeds never contain private stuff by default.
    AND.push(Prisma.sql`${pSql}."availability" != 'Private'::"Availability"`);
  }

  if (supportsGeneration) {
    AND.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "GenerationCoverage" gc WHERE gc."modelId" = m."id" AND gc."covered" = true)`
    );
  }

  if (isFeatured) {
    const featuredModels = await getFeaturedModels();
    AND.push(
      Prisma.sql`mm."modelId" IN (${Prisma.join(
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

    // A semi-join cannot expose ci."id" to the ORDER BY. Safe to widen: CollectionItem is unique on
    // ("collectionId", "modelId"), so the join cannot multiply rows. schema.full.prisma does not
    // declare it, and the name has drifted — CollectionItem_model_idx in
    // containers/db/docker-init/02_all_dll.sql, CollectionItem_model on prod.
    if (sort === ModelSort.RecentlyAdded) {
      collectionJoin = Prisma.sql`JOIN "CollectionItem" ci ON ci."modelId" = mm."modelId"
        AND ci."collectionId" = ${collectionId}
        AND ${Prisma.join(collectionItemModelsAND, ' AND ')}
        ${collectionTagId ? Prisma.sql`AND ci."tagId" = ${collectionTagId}` : Prisma.empty}`;
    } else {
      AND.push(
        Prisma.sql`EXISTS (
        SELECT 1 FROM "CollectionItem" ci
        WHERE ci."modelId" = mm."modelId"
        AND ci."collectionId" = ${collectionId}
        AND ${Prisma.join(collectionItemModelsAND, ' AND ')}
        ${collectionTagId ? Prisma.sql`AND ci."tagId" = ${collectionTagId}` : Prisma.empty}
      )`
      );
    }

    isPrivate = !permissions.publicCollection;
  }

  // Exclude user content
  if (excludedUserIds?.length) {
    AND.push(Prisma.sql`mm."userId" != ALL(${excludedUserIds}::int[])`);
  }

  // Build ORDER BY - use pAlias for per-base-model stats (downloadCount, thumbsUpCount, imageCount)
  // Use mm.* for model-level stats (commentCount, collectedCount, lastVersionAt)
  let orderBy = `mm."lastVersionAt" DESC NULLS LAST, ${pAlias}."modelId" DESC`;

  if (sort === ModelSort.HighestRated)
    orderBy = `${pAlias}."thumbsUpCount" DESC, ${pAlias}."downloadCount" DESC, ${pAlias}."modelId"`;
  else if (sort === ModelSort.MostLiked)
    orderBy = `${pAlias}."thumbsUpCount" DESC, ${pAlias}."downloadCount" DESC, ${pAlias}."modelId"`;
  else if (sort === ModelSort.MostDownloaded)
    orderBy = `${pAlias}."downloadCount" DESC, ${pAlias}."thumbsUpCount" DESC, ${pAlias}."modelId"`;
  else if (sort === ModelSort.MostDiscussed)
    orderBy = `mm."commentCount" DESC, ${pAlias}."thumbsUpCount" DESC, ${pAlias}."modelId"`;
  else if (sort === ModelSort.MostCollected)
    orderBy = `mm."collectedCount" DESC, ${pAlias}."thumbsUpCount" DESC, ${pAlias}."modelId"`;
  else if (sort === ModelSort.ImageCount)
    orderBy = `${pAlias}."imageCount" DESC, ${pAlias}."thumbsUpCount" DESC, ${pAlias}."modelId"`;
  else if (sort === ModelSort.Oldest) orderBy = `mm."lastVersionAt" ASC, ${pAlias}."modelId"`;
  else if (sort === ModelSort.RecentlyAdded) orderBy = `ci."id" DESC`;

  // Cursor predicate split (perf): we build two branches that are combined with
  // UNION ALL when there is a multi-field sort + cursor. The OR-form predicate
  // produced by the legacy `getCursor` can't be pushed into an index seek and
  // degrades sharply at deep offsets (~211 ms on production at offset ~100K vs
  // ~0.83 ms for the UNION ALL form). When splittable=false (no cursor or
  // single-field sort), we apply the strict clause directly to AND like before.
  const {
    strict: cursorStrict,
    equality: cursorEquality,
    prop: cursorProp,
    splittable,
  } = getCursorClauses(orderBy, cursor);
  if (!splittable && cursorStrict) AND.push(cursorStrict);

  if (!!fileFormats?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ModelFile" mf
      JOIN "ModelVersion" mv ON mf."modelVersionId" = mv."id" AND mv."modelId" = mm."modelId"
      WHERE mf."modelVersionId" = mv."id"
        AND mf."type" = 'Model'
        AND (${Prisma.join(
          fileFormats.map((format) => Prisma.raw(`mf."metadata" @> '{"format": "${format}"}'`)),
          ' OR '
        )})
    )`);
  }

  const browsingLevelQuery = Prisma.sql`(${pSql}."nsfwLevel" & ${browsingLevel}) != 0`;
  if (pending && (isModerator || userId)) {
    if (isModerator) {
      AND.push(Prisma.sql`(${browsingLevelQuery} OR ${pSql}."nsfwLevel" = 0)`);
    } else if (userId) {
      AND.push(
        Prisma.sql`(${browsingLevelQuery} OR (${pSql}."nsfwLevel" = 0 AND mm."userId" = ${userId}))`
      );
    }
  } else {
    AND.push(browsingLevelQuery);
  }

  const queryWith = Prisma.sql``;

  // Build dynamic FROM clause based on query path
  // Four paths:
  // 1. Standard: ModelMetric JOIN Model (no base model metrics)
  // 2. Base model metrics, single base model: direct JOIN on ModelBaseModelMetric
  //    (preserves covering index scan + sort order + early LIMIT termination)
  // 3. Base model metrics, multiple base models, lastVersionAt-based sort
  //    (Newest/Oldest): drive from ModelMetric so the feed_newest/feed_oldest
  //    index seek + cursor pushdown work; semi-join to ModelBaseModelMetric via
  //    EXISTS; pull per-base-model rank sums via LATERAL that fires only for the
  //    LIMIT survivors.
  // 4. Base model metrics, multiple base models, per-base-model-stat sort
  //    (HighestRated/MostDownloaded/ImageCount): aggregate subquery on
  //    ModelBaseModelMetric so the mbmm_feed_* covering indexes can be used.
  const fromClause = !useBaseModelMetrics
    ? Prisma.sql`FROM "ModelMetric" mm
      JOIN "Model" m ON m."id" = mm."modelId"`
    : baseModels!.length === 1
    ? Prisma.sql`FROM "ModelBaseModelMetric" mbm
      JOIN "Model" m ON m."id" = mbm."modelId"
      JOIN "ModelMetric" mm ON mm."modelId" = mbm."modelId"`
    : useNewestOldestMultiBmPath
    ? Prisma.sql`FROM "ModelMetric" mm
      JOIN "Model" m ON m."id" = mm."modelId"
      LEFT JOIN LATERAL (
        SELECT
          SUM("downloadCount")::int as "downloadCount",
          SUM("thumbsUpCount")::int as "thumbsUpCount"
        FROM "ModelBaseModelMetric"
        WHERE "modelId" = mm."modelId"
          AND "baseModel" IN (${Prisma.join(baseModels!, ',')})
      ) mbm ON true`
    : Prisma.sql`FROM (
        SELECT "modelId",
          SUM("downloadCount")::int as "downloadCount",
          SUM("thumbsUpCount")::int as "thumbsUpCount",
          SUM("imageCount")::int as "imageCount",
          MIN("status") as "status",
          MIN("nsfwLevel") as "nsfwLevel",
          MIN("availability") as "availability",
          MIN("mode") as "mode",
          MAX("minor"::int)::bool as "minor",
          MAX("poi"::int)::bool as "poi"
        FROM "ModelBaseModelMetric"
        WHERE "baseModel" IN (${Prisma.join(baseModels!, ',')})
        GROUP BY "modelId"
      ) mbm
      JOIN "Model" m ON m."id" = mbm."modelId"
      JOIN "ModelMetric" mm ON mm."modelId" = mbm."modelId"`;

  // Unified query - uses pSql for denormalized fields and per-base-model stats.
  //
  // Branch shape: the SELECT list, FROM/JOIN, and ORDER BY are identical between
  // branches. Only the WHERE predicate differs. We extract them as reusable
  // fragments so the splittable path can emit a UNION ALL of two branches
  // (strict tuple-compare + tie-handler) with no duplication.
  const selectList = Prisma.sql`
      ${pSql}."modelId" as "id",
      m."name",
      ${ifDetails`
        m."description",
        m."allowNoCredit",
        m."allowCommercialUse",
        m."allowDerivatives",
        m."allowDifferentLicense",
      `} m."type",
      ${pSql}."minor",
      m."sfwOnly",
      ${pSql}."poi",
      m."nsfw",
      ${pSql}."nsfwLevel",
      ${pSql}."status",
      m."createdAt",
      mm."lastVersionAt",
      m."publishedAt",
      m."locked",
      m."meta",
      ${pSql}."mode",
      ${pSql}."availability",
      jsonb_build_object(
        'downloadCount', ${rankPSql}."downloadCount",
        'thumbsUpCount', ${rankPSql}."thumbsUpCount",
        'thumbsDownCount', mm."thumbsDownCount",
        'commentCount', mm."commentCount",
        'collectedCount', mm."collectedCount",
        'tippedAmountCount', mm."tippedAmountCount"
      ) as "rank",
      mm."userId",
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} as "cursorId"`;

  const fromAndJoin = Prisma.sql`${fromClause}
      ${collectionJoin}`;

  const limitValue = (take ?? 100) + 1;
  const orderByRaw = Prisma.raw(orderBy);
  const baseAndClause = Prisma.join(AND, ' AND ');

  const modelQuery =
    splittable && cursorStrict && cursorEquality
      ? // Split-cursor path: UNION ALL of (equality tie-handler branch) +
        // (strict tuple-compare branch). The strict branch carries 99%+ of the
        // rows and benefits from an index seek. The equality branch is a
        // bounded "ties at the cursor boundary" lookup that almost always
        // returns 0 rows ("never executed" in most plans).
        //
        // Branch order matters: for DESC head fields, equality rows
        // (head = cursor values) sort BEFORE strict rows (head < cursor values).
        // PostgreSQL's Append node returns rows from the first child fully
        // before the second, so emitting equality first yields the correct
        // merged sort order without an outer ORDER BY. We can't add an outer
        // ORDER BY because output column names don't preserve table aliases
        // (mm."lastVersionAt" → "lastVersionAt"; thumbsUpCount/downloadCount
        // are buried inside the rank JSONB and aren't directly accessible).
        Prisma.sql`
    ${queryWith}
    (
      SELECT
        ${selectList}
      ${fromAndJoin}
      WHERE
        ${baseAndClause} AND ${cursorEquality}
      ORDER BY
        ${orderByRaw}
      LIMIT ${limitValue}
    )
    UNION ALL
    (
      SELECT
        ${selectList}
      ${fromAndJoin}
      WHERE
        ${baseAndClause} AND ${cursorStrict}
      ORDER BY
        ${orderByRaw}
      LIMIT ${limitValue}
    )
    LIMIT ${limitValue}
  `
      : // No cursor or single-field sort: original single-branch query
        // (cursorStrict, when present, has already been pushed into AND above).
        Prisma.sql`
    ${queryWith}
    SELECT
      ${selectList}
    ${fromAndJoin}
    WHERE
      ${baseAndClause}
    ORDER BY
      ${orderByRaw}
    LIMIT ${limitValue}
  `;

  // const models = await dbRead.$queryRaw<(ModelRaw & { cursorId: string | bigint | null })[]>(
  //   modelQuery
  // );
  const pgQuery = await pgDbRead.cancellableQuery<ModelRaw & { cursorId: string | bigint | null }>(
    modelQuery
  );
  const models = await pgQuery.result();

  const userIds = [...new Set(models.map((m) => m.userId))];
  const modelIds = models.map((m) => m.id);

  const [
    userBasicData,
    profilePictures,
    userCosmetics,
    modelData,
    cosmetics,
    earlyAccessDeadlines,
  ] = await withSpan('model:getAll:parallelFetch', () =>
    Promise.all([
      userBasicCache.fetch(userIds),
      getProfilePicturesForUsers(userIds),
      getCosmeticsForUsers(userIds),
      dataForModelsCache.fetch(modelIds),
      includeCosmetics
        ? getCosmeticsForEntity({ ids: modelIds, entity: 'Model' })
        : ({} as Record<string, WithClaimKey<ContentDecorationCosmetic>>),
      getModelEarlyAccessDeadlines(modelIds),
    ])
  );
  for (const model of models) {
    model.earlyAccessDeadline = earlyAccessDeadlines.get(model.id) ?? null;
  }

  let nextCursor: string | bigint | undefined;
  if (take && models.length > take) {
    nextCursor = models[models.length - 1]?.cursorId || undefined; // Use final item as cursor to grab next page
    models.pop(); //Remove excess model
  }

  return {
    items: withSpan('model:getAll:transform', () =>
      models
        .map(({ rank, cursorId, meta, ...model }) => {
          const data = modelData[model.id.toString()];
          if (!data) return null;

          let modelVersions = data.versions;

          // Visibility filters first, so the badge's base-model list reflects only
          // versions the viewer can actually see (no Private/license-restricted leaks).
          if (!sessionUser?.isModerator || !status?.length) {
            modelVersions = modelVersions.filter((mv) => mv.status === ModelStatus.Published);
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
            modelVersions = modelVersions.filter((mv) => mv.availability === 'Public');
          }

          // Distinct base models across the visible versions — surfaced to the card
          // badge for multi-base support and matched-first ordering. Computed before
          // the selection filters below so it covers all of the model's visible bases,
          // not just the one matched by an active base-model filter.
          const allBaseModels = [...new Set(modelVersions.map((mv) => mv.baseModel))];

          // Selection filters — narrow to the versions matching the active query.
          if (baseModels) {
            modelVersions = modelVersions.filter((mv) => baseModels.includes(mv.baseModel));
          }

          if (!!modelVersionIds?.length) {
            modelVersions = modelVersions.filter((mv) => modelVersionIds.includes(mv.id));
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
              [`collectedCount${input.period}`]: rank.collectedCount,
              [`tippedAmountCount${input.period}`]: rank.tippedAmountCount,
            },
            modelVersions,
            baseModels: allBaseModels,
            hashes: data.hashes,
            tagsOnModels: data.tags,
            user: {
              id: model.userId,
              username: userBasicData[model.userId]?.username ?? null,
              deletedAt: userBasicData[model.userId]?.deletedAt ?? null,
              image: userBasicData[model.userId]?.image ?? null,
              profilePicture: profilePictures?.[model.userId] ?? null,
              cosmetics: userCosmetics[model.userId] ?? [],
            },
            cosmetic: cosmetics[model.id] ?? null,
            metricPrivacy: getMetaMetricPrivacy(meta),
          };
        })
        .filter(isDefined)
    ),
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
  const blockedEnforcement = await enforceBlockedBrowsingTagsForModels(input, {
    id: sessionUser?.id,
    username: sessionUser?.username,
    isModerator: sessionUser?.isModerator,
  });
  if (blockedEnforcement.emptyResult) {
    return count ? { items: [], count: 0 } : { items: [], isPrivate: false };
  }

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
    paidAccess,
    supportsGeneration,
    followed,
    collectionId,
    fileFormats,
    browsingLevel,
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
  if (excludedTagIds && excludedTagIds.length) {
    AND.push({
      OR: [
        { tagsOnModels: { none: { tagId: { in: excludedTagIds } } } },
        ...(sessionUser?.id ? [{ userId: sessionUser.id }] : []),
      ],
    });
  }
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
    AND.push({ id: { in: await getActiveEarlyAccessModelIds() } });
  }

  if (paidAccess) {
    AND.push({ id: { in: await getPermanentPaidAccessModelIds() } });
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

export type GetModelsWithImagesAndModelVersions = AsyncReturnType<
  typeof getModelsWithImagesAndModelVersions
>['items'][0];

export const getModelsWithImagesAndModelVersions = async ({
  input,
  user,
  // Per-model image cap for the RESPONSE (the shared image cache is untouched).
  // The browse-feed controller selects the SLIM cap when the DARK
  // `getAllModelImagesSlim` flag is on; other callers (home blocks, collections)
  // default to `GET_ALL_IMAGES_PER_MODEL`.
  imagesPerModel = GET_ALL_IMAGES_PER_MODEL,
  // When true (flag-ON browse feed only) pick the nsfw-biased coverage slice instead
  // of the naive first-`imagesPerModel`, so reducing the count adds ~zero feed drops.
  biasImageSlice = false,
  // Read-time Creator-Controls metric-privacy gate (#3266 A/B). DEFAULTS TRUE so
  // callers that don't thread it (home blocks, collections) keep today's behavior;
  // the browse-feed controller passes the once-per-request `modelMetricPrivacyReadtime`
  // flag. When false, the per-request owner-settings + membership work below is
  // skipped and raw metrics are emitted (pre-#3266 visibility).
  metricPrivacyEnabled = true,
  domain,
}: {
  input: GetAllModelsOutput;
  user?: SessionUser;
  imagesPerModel?: number;
  biasImageSlice?: boolean;
  metricPrivacyEnabled?: boolean;
  domain?: DomainColor;
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
    domain,
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

  // Creator Controls metric privacy for the card feed. Fetch owner defaults once,
  // then only resolve CP membership for owners who actually have a hide flag set
  // (keeps the common no-flags case free of membership lookups).
  // Flag-gated (#3266 A/B): when `metricPrivacyEnabled` is false the whole batched
  // owner-settings + `getValidCreatorMembershipMap` block is skipped and raw metrics
  // are emitted (pre-#3266 visibility).
  const isMod = !!user?.isModerator;
  // Cache-backed per-owner metric-privacy DEFAULT flags (the three `hideModel*`
  // booleans). Replaces a per-request `dbRead.user.findMany({ settings })` that
  // deserialized every owner's full `settings` blob just to read three booleans — the
  // measured api-primary read-time longtask (#3266). Values are the tiny derived slice,
  // fed unchanged into the resolvers below (byte-identical).
  let feedOwnerSettingsMap = new Map<number, unknown>();
  let feedMembershipMap = new Map<number, boolean>();
  if (metricPrivacyEnabled) {
    const feedOwnerIds = [...new Set(items.map((m) => m.user.id))];
    feedOwnerSettingsMap = await getUserMetricPrivacyDefaultsMap(feedOwnerIds);
    const membershipCandidates = new Set<number>();
    for (const it of items) {
      const ownerId = it.user.id;
      if (isMod || ownerId === user?.id) continue;
      const defHidden = getUserMetricPrivacyDefaults(feedOwnerSettingsMap.get(ownerId));
      if (anyMetricHidden(it.metricPrivacy) || anyMetricHidden(defHidden))
        membershipCandidates.add(ownerId);
    }
    feedMembershipMap = await getValidCreatorMembershipMap([...membershipCandidates]);
  }
  const toMetaShape = (h: HiddenModelMetrics) => ({
    hideBuzz: h.buzz,
    hideDownloads: h.downloads,
    hideGenerations: h.generations,
  });

  const result = {
    nextCursor,
    isPrivate,
    items: items
      .map(({ hashes, modelVersions, rank, tagsOnModels, metricPrivacy, ...model }) => {
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
          !!version?.covered &&
          !isGenerationDisabled(version.flags) &&
          isBaseModelGenerationSupported(version.baseModel, model.type);

        const isOwner = isMod || model.user.id === user?.id;
        const modelHidden = gateHiddenMetrics(metricPrivacyEnabled, () =>
          resolveModelHiddenMetrics({
            modelMeta: toMetaShape(metricPrivacy),
            userSettings: feedOwnerSettingsMap.get(model.user.id),
            isOwnerOrModerator: isOwner,
            hasValidMembership: feedMembershipMap.get(model.user.id) ?? false,
          })
        );

        return {
          ...model,
          tags: tagsOnModels.map((x) => x.tagId), // not sure why we even use scoring here...
          hashes: hashes.map((hash) => hash.toLowerCase()),
          hiddenMetrics: modelHidden,
          rank: {
            downloadCount: modelHidden.downloads
              ? null
              : rank?.[`downloadCount${input.period}`] ?? 0,
            thumbsUpCount: rank?.[`thumbsUpCount${input.period}`] ?? 0,
            thumbsDownCount: rank?.[`thumbsDownCount${input.period}`] ?? 0,
            commentCount: rank?.[`commentCount${input.period}`] ?? 0,
            collectedCount: rank?.[`collectedCount${input.period}`] ?? 0,
            tippedAmountCount: modelHidden.buzz
              ? null
              : rank?.[`tippedAmountCount${input.period}`] ?? 0,
          },
          version,
          // // !important - for feed queries, when `model.nsfw === true`, we set all image `nsfwLevel` values to `NsfwLevel.XXX`
          // images: model.nsfw
          //   ? versionImages.map((x) => ({ ...x, nsfwLevel: NsfwLevel.XXX }))
          //   : versionImages,
          // Trim the images in the getAll (browse feed) response — the #1
          // serialize-freeze source. `buildGetAllModelImages` caps the array to
          // `imagesPerModel` (flag-selected) AND drops the per-image fields no
          // consumer reads (always-on). It returns NEW arrays/objects, so the
          // shared `imagesForModelVersionsCache` entries (still used at full 20
          // with all fields by model-detail pages, auctions, etc.) are untouched.
          // See `~/server/utils/model-getall-images`.
          images: buildGetAllModelImages(filteredImages, imagesPerModel, biasImageSlice),
          canGenerate,
        };
      })
      .filter(isDefined),
  };

  return result;
};

/**
 * Re-queue a user's published models for search reindex. Creator Controls metric
 * privacy is baked into the search doc (effective = flag AND active membership), so
 * a `hideModel*` user-setting flip or a membership lapse must re-run the transform,
 * otherwise the search cards stay stale (over-hidden after a lapse; user-default
 * flips invisible until an incidental reindex).
 */
export async function queueModelMetricPrivacyReindex(userId: number) {
  if (!userId) return;
  const models = await dbRead.model.findMany({
    where: { userId, status: ModelStatus.Published },
    select: { id: true },
  });
  if (!models.length) return;
  await modelsSearchIndex.queueUpdate(
    models.map((m) => ({ id: m.id, action: SearchIndexUpdateQueueAction.Update }))
  );
}

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
      createdAt: true,
      publishedAt: true,
    },
  });

  const paidAccess = await getPaidAccess(
    'ModelVersion',
    versions.map((v) => v.id)
  );
  return versions.map((v) => {
    const row = paidAccess[v.id];
    return { ...v, isEarlyAccess: !!row && isPaidAccessActive(row) };
  });
};

// Mutations hand their updated row straight back to the caller, so the moderation-only
// minor-hash keys have to come off here. Stripping beats narrowing the Prisma `select`:
// these rows feed many callers, and the keys are only ever read back through the
// minor-hash service's own raw SQL.
function withoutMinorHashMeta<T extends { meta: unknown }>(model: T): T {
  return { ...model, meta: stripMinorHashMeta(model.meta as ModelMeta | null) } as T;
}

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

  await userModelCountCache.refresh(model.userId);
  // Flag replica-lag on the model BEFORE busting so a concurrent edge-miss read
  // routes the LAG-AWARE parts of the rebuild to primary during the replication
  // window instead of repopulating the just-busted response cache with pre-takedown
  // state. Mirrors the publish/unpublish paths.
  //
  // SCOPE (important — do not overstate): this flag only covers the data that flows
  // through dataForModelsCache.lookupFn -> getDbWithoutLagBatch('model', ids) — i.e.
  // the VERSION-level fields (status/availability/covered). It does NOT cover the
  // base Model row read by getModelsRaw, which uses pgDbRead unconditionally
  // (model.service.ts ~910) and is never lag-aware. That base row carries
  // `model.mode` — the field that gates images/downloadUrl in the cached body
  // ([id].ts: includeImages/includeDownloadUrl). So a takedown's `mode` can still be
  // read stale from a lagging replica and repopulate the origin cache for up to the
  // origin TTL (CacheTTL.sm, 180s). That residual is bounded by — and ⊆ — the
  // pre-existing Cloudflare edge window (s-maxage=300s), which this Redis-only bust
  // does NOT purge anyway; so this does not widen takedown exposure beyond the edge.
  // (To fully close the origin half, getModelsRaw's base read would need to honor
  // the 'model' lag flag — deliberately not done here to avoid touching that shared
  // hot path for an origin window already inside the edge window.)
  await preventModelVersionLagBatch(id, []);
  // Drop the origin-side public GET /api/v1/models/[id] response cache (Redis only;
  // not the CF edge). Takedown/archive (changeModelModifierHandler sets `mode`) flows
  // through here, and the cached body's images/files/downloadUrl depend on
  // `model.mode` — without this the origin keeps serving a stale 200 for up to the TTL.
  await bustPublicModelResponseCache(id);

  return withoutMinorHashMeta(model);
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
          'unpublishedBy', ${userId},
          'prevPublishedAt', "publishedAt"
                                       ),
            "publishedAt" = NULL
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
    await userModelCountCache.refresh(deletedModel.userId);
  }
  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
  // Flag replica-lag BEFORE busting so a concurrent edge-miss read routes the
  // lag-aware version data (dataForModelsCache.lookupFn) to primary instead of
  // repopulating the just-busted cache with pre-delete state. Mirrors publish/
  // unpublish; version ids are in scope here from the delete transaction. (Same
  // scope caveat as updateModelById: the getModelsRaw base row is not lag-aware —
  // but for a delete the model row is gone, so a fresh read rebuilds to null→404,
  // never cached, so the base-row gap is benign on this path.)
  const deletedVersionIds = deletedModel?.modelVersions.map((v) => v.id) ?? [];
  await preventModelVersionLagBatch(id, deletedVersionIds);
  // Drop the deleted model's post images from the image search index — parity
  // with unpublishModelById / permaDeleteModelById. The image index doesn't
  // filter on model status, so without this a soft-deleted model's images keep
  // surfacing in Meili-backed feeds even though the DB feed already hides them.
  // dbWrite to dodge replica lag on the just-committed txn (same as unpublish).
  if (deletedModel && deletedVersionIds.length) {
    try {
      const deletedPosts = await dbWrite.post.findMany({
        where: { modelVersionId: { in: deletedVersionIds }, userId: deletedModel.userId },
        select: { id: true },
      });
      if (deletedPosts.length) {
        const deletedImages = await dbWrite.image.findMany({
          where: { postId: { in: deletedPosts.map((p) => p.id) } },
          select: { id: true },
        });
        if (deletedImages.length)
          await queueImageSearchIndexUpdate({
            ids: deletedImages.map((i) => i.id),
            action: SearchIndexUpdateQueueAction.Delete,
          });
      }
    } catch (error) {
      // Best-effort: the model is already committed-deleted, so an index-queue
      // hiccup must not throw to the caller and skip the trailing cache busts.
      logToAxiom({
        type: 'error',
        name: 'model-delete-image-search-index',
        message: `Failed to queue image search index update for model ${id}`,
        error,
      });
    }
  }
  // Drop the origin-side public GET /api/v1/models/[id] response cache so a
  // deleted model stops serving a stale 200 (it would 404 on rebuild).
  await bustPublicModelResponseCache(id);
  await deleteBidsForModel({ modelId: id });

  return deletedModel;
};

export const restoreModelById = async ({ id }: GetByIdInput) => {
  // Derive restored status from publishedAt so a previously-public model
  // returns to Unpublished (was public -> hidden) rather than Draft. Blanket
  // Draft would let the next publish reset publishedAt under the legacy gate
  // (the anti-bump SQL guard now blocks that, but mismatched status was its
  // own UX bug — restored work shouldn't pretend it was never published).
  //   publishedAt IS NULL    -> Draft
  //   publishedAt >  NOW()   -> Scheduled (future publish was queued)
  //   publishedAt <= NOW()   -> Unpublished
  //
  // 🔴 `"updatedAt" = now()` is load-bearing. This is `$queryRaw`, so Prisma's
  // `@updatedAt` does NOT fire and the row keeps the timestamp it carried while
  // deleted — the deletion instant, since `deleteModelById` writes through the
  // client.
  //
  // 🔴 READ THE REAPER'S PREDICATE BEFORE EDITING THIS COMMENT. Three successive
  // versions of it justified the bump with a story about what restoring does,
  // and all three were false. `remove-old-drafts` selects on:
  //
  //     status IN ('Draft','Deleted')
  //     AND m."updatedAt" < now() - INTERVAL '30 days'   -- REAP_AGE_DAYS
  //     AND mm."downloadCount" < 10
  //     AND m."availability" != 'Private'
  //     AND NOT EXISTS (recent ModelVersion) AND NOT EXISTS (recent ModelFile)
  //
  // `'Deleted'` is IN that set, so the clock is already running while the model
  // sits deleted: a low-download model is destroyed the night after
  // deletion + 30 days, still `Deleted`, having never been restored. Restoring
  // changes exactly one term — status goes `Deleted` -> `Draft` (still in the
  // set) or `Unpublished`/`Scheduled` (out of it). Nothing else the predicate
  // reads moves: the `ModelVersion` statement below is raw SQL and does not bump
  // `mv."updatedAt"` either, and downloadCount / availability / the ModelMetric
  // join are untouched. **The post-restore candidate set is therefore a strict
  // subset of the pre-restore one — without this bump, restoring can never make
  // a model reapable that was not already.** Do not re-justify this line with a
  // "restore it and it dies that night" scenario; no such model exists.
  //
  // What the bump actually buys, both real:
  //
  //  1. A PARTLY-SPENT CLOCK. Deleted day 0, restored day 29: without the bump
  //     the model is reaped the night of day 30/31 — one day after restore, with
  //     the version fence (where the delete set one at all) expiring at the same
  //     instant. The bump turns whatever remains of the window into a full
  //     REAP_AGE_DAYS, which is what a restored model is entitled to.
  //  2. THE `old-draft` WARNING, and this is the stronger one. That notification
  //     warns on `Draft` ONLY — a `Deleted` model is deliberately never warned —
  //     and its band is evaluated ONCE, at `U + OLD_DRAFT_NOTICE_DAYS` (23 days),
  //     never re-evaluated for that `U` (`model.notifications.ts`). A model
  //     restored while carrying its pre-restore `U` is now `Draft`, so it is
  //     warnable for the first time — but only if its band has not already gone
  //     by.
  //       - restored BEFORE `U + 23d`: the band still matches, and it IS warned.
  //         Deleted day 0, restored day 10 -> `Draft` at day 23 with `U` = day 0
  //         -> warned. The bump is not what saves this one.
  //       - restored AFTER `U + 23d` (the day-29 case above, or a path where
  //         `downloadCount` drops below 10 late): the band is in the past and is
  //         never revisited, so the model is cascade-deleted UNWARNED.
  //     So the bump re-arms the band, and that is the only way the user hears
  //     about it in the second case. Stated at that width deliberately: this
  //     comment tells the next editor not to justify the line from a story, so
  //     it has to meet its own bar.
  //
  // And independently of the reaper: restoring a model is a write to the row, so
  // the bump is what the column is supposed to mean.
  //
  // (Nuance, so the fences are not over-credited: `deleteModelById`'s nested
  // `modelVersions.updateMany` is scoped to `status IN (Published, Scheduled)`,
  // so a Draft-only model has NO ModelVersion row bumped at delete time. Those
  // timestamps are older still, making the fences less protective, not more.)
  //
  // Pinned by `no-unbumped-draft-status-write.test.ts` and exercised through
  // this function by `restore-model-updated-at.service.test.ts`.
  const result = await dbWrite.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ userId: number }[]>`
      UPDATE "Model"
      SET "deletedAt" = NULL,
          "deletedBy" = NULL,
          "status" = CASE
            WHEN "publishedAt" IS NULL      THEN 'Draft'::"ModelStatus"
            WHEN "publishedAt" >  NOW()     THEN 'Scheduled'::"ModelStatus"
            ELSE 'Unpublished'::"ModelStatus"
          END,
          "updatedAt" = now()
      WHERE id = ${id}
        AND "status" = 'Deleted'::"ModelStatus"
      RETURNING "userId"
    `;
    await tx.$executeRaw`
      UPDATE "ModelVersion"
      SET "status" = CASE
        WHEN "publishedAt" IS NULL  THEN 'Draft'::"ModelStatus"
        WHEN "publishedAt" >  NOW() THEN 'Scheduled'::"ModelStatus"
        ELSE 'Unpublished'::"ModelStatus"
      END
      WHERE "modelId" = ${id}
        AND "status" = 'Deleted'::"ModelStatus"
    `;
    return rows[0] ?? null;
  });

  if (!result) return null;
  await userModelCountCache.refresh(result.userId);

  return { id, userId: result.userId };
};

export const permaDeleteModelById = async ({
  id,
}: GetByIdInput & {
  userId: number;
}) => {
  // Populated inside the tx so the snapshot is consistent with the cascade.
  let modelFileUrls: string[] = [];
  // Version ids captured inside the tx (before the cascade removes them) so the
  // post-commit storage-resolver deregister can reach every reaped version.
  let versionIds: number[] = [];

  // Resolved BEFORE the tx, not inside it and not after: `CollectionItem` cascades
  // from both `Model` and `Image`, so post-commit there is nothing left to read, and a
  // failed statement inside a Postgres tx aborts the whole tx — this bookkeeping read
  // must never be able to take the delete down with it. The resolver is non-throwing,
  // so a failure costs the reindex, not the deletion.
  const collectionsToRebuild = await getCollectionIdsForModelCascade({ modelId: id });

  const deletionResult = await dbWrite.$transaction(
    async (tx) => {
      // Snapshot ModelFile URLs inside the tx — read before the cascade nukes the rows.
      modelFileUrls = (
        await tx.modelFile.findMany({
          where: { modelVersion: { modelId: id } },
          select: { url: true },
        })
      ).map((f) => f.url);

      const model = await tx.model.findUnique({
        where: { id },
        select: {
          id: true,
          userId: true,
          nsfwLevel: true,
          modelVersions: { select: { id: true } },
        },
      });
      if (!model) return { deletedModel: null, imagesToDelete: [] };

      versionIds = model.modelVersions.map(({ id }) => id);

      // Get posts to find associated images
      const posts = await tx.post.findMany({
        where: {
          userId: model.userId,
          modelVersionId: { in: model.modelVersions.map(({ id }) => id) },
        },
        select: { id: true },
      });
      const postIds = posts.map((post) => post.id);

      // Get images to delete and queue search index updates
      let imagesToDelete: { id: number }[] = [];
      if (postIds.length > 0) {
        imagesToDelete = await tx.image.findMany({
          where: { postId: { in: postIds } },
          select: { id: true },
        });

        await tx.image.deleteMany({
          where: { postId: { in: postIds } },
        });
      }

      await tx.post.deleteMany({
        where: {
          userId: model.userId,
          modelVersionId: { in: model.modelVersions.map(({ id }) => id) },
        },
      });

      const deletedModel = await tx.model.delete({ where: { id } });
      return { deletedModel, imagesToDelete };
    },
    { maxWait: 10000, timeout: 30000 }
  );

  const { deletedModel, imagesToDelete } = deletionResult;

  if (deletedModel) {
    // Each post-commit step is independently best-effort. The DB tx already
    // committed, so a downstream failure in bid cleanup or search-index
    // queueing must NOT shortcut the S3 cleanup — otherwise we leak orphan
    // objects in B2/R2 every time one of these auxiliary services hiccups.
    try {
      await deleteBidsForModel({ modelId: deletedModel.id });
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'model-perma-delete-bids',
        message: `Failed to delete bids for model ${id}`,
        error,
      });
    }
    try {
      await modelsSearchIndex.queueUpdate([
        { id: deletedModel.id, action: SearchIndexUpdateQueueAction.Delete },
      ]);
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'model-perma-delete-search-index',
        message: `Failed to queue search index update for model ${id}`,
        error,
      });
    }
    if (imagesToDelete.length > 0) {
      try {
        await queueImageSearchIndexUpdate({
          ids: imagesToDelete.map((img) => img.id),
          action: SearchIndexUpdateQueueAction.Delete,
        });
      } catch (error) {
        logToAxiom({
          type: 'error',
          name: 'model-perma-delete-image-search-index',
          message: `Failed to queue image search index update for model ${id}`,
          error,
        });
      }
    }
    // Rebuild the collections that held this model, its posts or its gallery images,
    // using the pre-tx snapshot — the membership rows cascaded away with the delete,
    // so this is the only remaining record of which documents went stale.
    // `enqueueCollectionRebuild` is non-throwing by contract, but wrapped anyway so
    // this step matches its siblings above rather than resting the S3 and
    // storage-resolver cleanup below on another module keeping that promise.
    try {
      await enqueueCollectionRebuild({
        ...collectionsToRebuild,
        source: 'model-perma-delete',
      });
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'model-perma-delete-collection-search-index',
        message: `Failed to queue collection search index update for model ${id}`,
        // `logToAxiom` JSON.stringifies its payload and a bare Error serialises to
        // `{}`. The siblings above predate that finding; this one does not.
        error: safeError(error),
      });
    }
    // Clean up S3 objects for all deleted ModelFiles (admin-triggered, latency-tolerant → await).
    if (modelFileUrls.length > 0) {
      try {
        await deleteModelFileObjects(modelFileUrls);
      } catch (error) {
        logToAxiom({
          type: 'error',
          name: 'model-perma-delete-s3-objects',
          message: `Failed to delete S3 objects for model ${id}`,
          error,
        });
      }
    }
    // Post-commit: deregister storage-resolver file_locations for every version
    // this model owned. For a tiered file the real backend object is keyed by
    // file_locations.path (not the stale ModelFile.url the S3 cleanup used), and
    // the surviving row keeps that object whitelisted against the dereference-
    // quarantine sweep — a permanent leak. Best-effort + never throws.
    if (versionIds.length > 0) {
      try {
        await deregisterFileLocationsBatch(versionIds);
      } catch (error) {
        logToAxiom({
          type: 'error',
          name: 'model-perma-delete-deregister-file-locations',
          message: `Failed to deregister file locations for model ${id}`,
          error,
        });
      }
    }
  }

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

export async function applyModelFlagSideEffects({
  before,
  after,
  tagsChanged = false,
}: {
  before: {
    poi: boolean;
    minor: boolean;
    sfwOnly: boolean;
    nsfw: boolean;
    gallerySettings: Prisma.JsonValue;
  };
  after: {
    id: number;
    name: string;
    description: string | null;
    poi: boolean;
    nsfw: boolean;
    minor: boolean;
    sfwOnly: boolean;
    status: ModelStatus;
    gallerySettings: Prisma.JsonValue;
  };
  tagsChanged?: boolean;
}): Promise<void> {
  const { id } = after;
  const poiChanged = after.poi !== before.poi;
  const minorChanged = after.minor !== before.minor || after.sfwOnly !== before.sfwOnly;

  // Update search index if listing changes
  if (tagsChanged || poiChanged || minorChanged) {
    await modelTagCache.refresh(id);
    if (tagsChanged) await modelVotableTagsCache.bust(id);
    await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);
  }

  const prevGallerySettings = before.gallerySettings as ModelGallerySettingsSchema;
  const newGallerySettings = after.gallerySettings as ModelGallerySettingsSchema;
  const galleryBrowsingLevelChanged = prevGallerySettings?.level !== newGallerySettings?.level;

  if (galleryBrowsingLevelChanged) await redis.del(`${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${id}`);

  if (minorChanged || poiChanged) {
    const modelVersions = await dbWrite.modelVersion.findMany({
      where: { modelId: id },
      select: { id: true },
    });

    const modelVersionIds = modelVersions.map(({ id }) => id);

    if (modelVersionIds.length !== 0) {
      // Set-based on purpose: a gallery can hold hundreds of thousands of images, and
      // binding one parameter per image id blows past Postgres' 65535 parameter limit.
      // The value guard keeps a re-toggle from rewriting every row (and re-queueing every
      // id into the search index) when the flags already match.
      const updatedImages = await dbWrite.$queryRaw<{ id: number }[]>`
        UPDATE "Image" i
          SET minor = ${after.minor},
              poi = ${after.poi}
        FROM "Post" p
        WHERE i."postId" = p.id
          AND p."modelVersionId" IN (${Prisma.join(modelVersionIds, ',')})
          AND (i.minor IS DISTINCT FROM ${after.minor} OR i.poi IS DISTINCT FROM ${after.poi})
        RETURNING i.id
      `;

      if (updatedImages.length !== 0) {
        await queueImageSearchIndexUpdate({
          ids: updatedImages.map(({ id }) => id),
          action: SearchIndexUpdateQueueAction.Update,
        });
      }

      await bustMvCache(modelVersionIds, id);
    }
  }
}

// Kept in sync with `lockableProperties` in ModelUpsertForm.tsx — these are the
// fields the "Set as Minor" quick action locks against creator edits.
export const MINOR_LOCKED_PROPERTIES = ['minor', 'nsfw', 'sfwOnly'];

export type ModelMinorActivity =
  | 'setMinor'
  | 'unsetMinor'
  | 'setMinorAutoHash'
  | 'rollbackMinorAutoHash';

export const MINOR_FLAG_SNAPSHOT_KEY = 'minorFlagSnapshot';

// Flagging minor overwrites nsfw/sfwOnly/gallerySettings.level and propagates
// `minor` to every image, keeping no record of what was there before — so without
// this the change is unrecoverable, whether a job or a moderator made it.
// `source` is what lets a bulk rollback undo only the automated flags and leave
// deliberate moderator decisions alone.
// Idempotent via the WHERE guard: a re-flag can never clobber the original
// pre-state. Best-effort — losing the snapshot must block a later rollback, not
// the flag itself, so failures are logged rather than thrown.
async function captureMinorFlagSnapshot(modelId: number, source: 'auto' | 'manual') {
  try {
    await dbWrite.$executeRaw`
      UPDATE "Model" m
      SET meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(
        ${MINOR_FLAG_SNAPSHOT_KEY}, jsonb_build_object(
          'at', now(),
          'source', ${source},
          'prevNsfw', m.nsfw,
          'prevSfwOnly', m."sfwOnly",
          'prevGalleryLevel', (m."gallerySettings"->>'level')::int,
          'prevLockedProperties', to_jsonb(COALESCE(m."lockedProperties", ARRAY[]::text[])),
          'prevMinorImageIds', COALESCE((
            SELECT jsonb_agg(i.id)
            FROM "ModelVersion" mv
            JOIN "Post" p ON p."modelVersionId" = mv.id
            JOIN "Image" i ON i."postId" = p.id
            WHERE mv."modelId" = m.id AND i.minor
          ), '[]'::jsonb)
        )
      )
      WHERE m.id = ${modelId}
        AND NOT (COALESCE(m.meta, '{}'::jsonb) ? ${MINOR_FLAG_SNAPSHOT_KEY})
    `;
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'minor-flag-snapshot',
      message: error instanceof Error ? error.message : String(error),
      modelId,
    }).catch(() => null);
  }
}

export async function setModelMinor({
  id,
  minor,
  userId,
  activity,
}: SetModelMinorInput & { userId: number; activity?: ModelMinorActivity }) {
  const before = await dbRead.model.findUnique({
    where: { id },
    select: {
      poi: true,
      minor: true,
      sfwOnly: true,
      nsfw: true,
      gallerySettings: true,
      lockedProperties: true,
    },
  });
  if (!before) throw throwNotFoundError(`No model with id ${id}`);

  // Must run before the update below and before side effects propagate `minor`
  // to images, or the snapshot records post-flag state.
  if (minor)
    await captureMinorFlagSnapshot(id, activity === 'setMinorAutoHash' ? 'auto' : 'manual');

  const prevLockedProperties = before.lockedProperties ?? [];
  const lockedProperties = minor
    ? uniq([...prevLockedProperties, ...MINOR_LOCKED_PROPERTIES])
    : prevLockedProperties.filter((prop) => !MINOR_LOCKED_PROPERTIES.includes(prop));

  const prevGallerySettings = before.gallerySettings as ModelGallerySettingsSchema;

  const result = await dbWrite.model.update({
    where: { id },
    // Unset deliberately leaves sfwOnly/nsfw/gallerySettings untouched — the model may
    // have been legitimately SFW-only before it was flagged, and guessing wrong would
    // silently re-open NSFW generation nobody asked to re-open.
    data: minor
      ? {
          minor: true,
          nsfw: false,
          sfwOnly: true,
          gallerySettings: { ...prevGallerySettings, level: sfwBrowsingLevelsFlag },
          lockedProperties,
        }
      : {
          minor: false,
          lockedProperties,
        },
    select: {
      id: true,
      name: true,
      description: true,
      poi: true,
      nsfw: true,
      minor: true,
      sfwOnly: true,
      status: true,
      gallerySettings: true,
    },
  });

  await preventReplicationLag('model', id);
  // Audit before the fan-out: the flag write has already committed, so a fan-out
  // failure must not cost us the record of who flipped it. The audit write itself
  // must not block the fan-out either, so failures are logged, not thrown.
  await trackModActivity(userId, {
    entityType: 'model',
    entityId: id,
    activity: activity ?? (minor ? 'setMinor' : 'unsetMinor'),
  }).catch((error) =>
    logToAxiom({
      type: 'error',
      name: 'set-model-minor-track-activity',
      message: `Failed to track mod activity for model ${id}`,
      error,
    })
  );
  await applyModelFlagSideEffects({ before, after: result });

  return result;
}

// Kept in sync with `lockableProperties` in ModelUpsertForm.tsx — these are the
// fields the "Set as SFW" quick action locks against creator edits.
export const SFW_ONLY_LOCKED_PROPERTIES = ['nsfw', 'sfwOnly'];

export async function setModelSfwOnly({
  id,
  sfwOnly,
  userId,
}: SetModelSfwOnlyInput & { userId: number }) {
  const before = await dbRead.model.findUnique({
    where: { id },
    select: {
      poi: true,
      minor: true,
      sfwOnly: true,
      nsfw: true,
      availability: true,
      gallerySettings: true,
      lockedProperties: true,
    },
  });
  if (!before) throw throwNotFoundError(`No model with id ${id}`);

  // Both invariants are enforced by `ModelUpsertForm`'s schema, so clearing the flag here
  // would leave a model no creator could save again.
  if (!sfwOnly) {
    if (before.minor)
      throw throwBadRequestError('Minor models are SFW only. Unset as Minor first.');
    if (before.availability === Availability.Private)
      throw throwBadRequestError('Private models must be SFW only.');
  }

  const prevLockedProperties = before.lockedProperties ?? [];
  const lockedProperties = sfwOnly
    ? uniq([...prevLockedProperties, ...SFW_ONLY_LOCKED_PROPERTIES])
    : prevLockedProperties.filter((prop) => !SFW_ONLY_LOCKED_PROPERTIES.includes(prop));

  const prevGallerySettings = before.gallerySettings as ModelGallerySettingsSchema;

  const result = await dbWrite.model.update({
    where: { id },
    // Unset deliberately leaves nsfw/gallerySettings untouched — the model may have been
    // legitimately SFW before it was flagged, and guessing wrong would silently re-open
    // NSFW generation nobody asked to re-open.
    data: sfwOnly
      ? {
          sfwOnly: true,
          nsfw: false,
          gallerySettings: { ...prevGallerySettings, level: sfwBrowsingLevelsFlag },
          lockedProperties,
        }
      : {
          sfwOnly: false,
          lockedProperties,
        },
    select: {
      id: true,
      name: true,
      description: true,
      poi: true,
      nsfw: true,
      minor: true,
      sfwOnly: true,
      status: true,
      gallerySettings: true,
    },
  });

  await preventReplicationLag('model', id);
  await trackModActivity(userId, {
    entityType: 'model',
    entityId: id,
    activity: sfwOnly ? 'setSfwOnly' : 'unsetSfwOnly',
  }).catch((error) =>
    logToAxiom({
      type: 'error',
      name: 'set-model-sfw-only-track-activity',
      message: `Failed to track mod activity for model ${id}`,
      error,
    })
  );
  await applyModelFlagSideEffects({ before, after: result });

  return result;
}

// Model columns the GenerationCoverage view reads. `poi` belongs to the same set but is left out
// here because applyModelFlagSideEffects already busts the version caches when it moves.
const coverageModelFields = ['allowCommercialUse', 'availability', 'type', 'uploadType'] as const;

export const upsertModel = async (
  input: ModelUpsertInput & {
    userId: number;
    // meta?: Prisma.ModelCreateInput['meta']; // TODO.manuel: hardcoding meta type since it causes type issues in lots of places if we set it in the schema
    isModerator?: boolean;
    gallerySettings?: Partial<ModelGallerySettingsSchema>;
    tracker?: Tracker;
  }
) => {
  await throwOnBlockedUserContent([input.name, input.description], {
    isModerator: input.isModerator,
    surface: 'model',
  });

  const {
    id,
    tagsOnModels,
    userId,
    templateId,
    bountyId,
    isModerator,
    status,
    gallerySettings,
    tracker,
    ...data
  } = input;
  // `modelUpsertSchema.meta` is a looseObject and the client's copy wins the merge
  // below, so moderation-owned keys have to be dropped before anything reads them.
  // Runs ahead of the profanity branch, which adds its own keys to this same object.
  let meta = stripModerationOwnedMeta(input.meta, isModerator);

  const beforeUpdate =
    id && !templateId
      ? await dbRead.model.findUnique({
          where: { id },
          select: {
            name: true,
            description: true,
            poi: true,
            userId: true,
            minor: true,
            sfwOnly: true,
            nsfw: true,
            lockedProperties: true,
            gallerySettings: true,
            meta: true,
            availability: true,
            mode: true,
            allowNoCredit: true,
            allowCommercialUse: true,
            allowDerivatives: true,
            allowDifferentLicense: true,
            type: true,
            uploadType: true,
          },
        })
      : null;

  const storedLockedProperties = beforeUpdate?.lockedProperties ?? [];
  enforceLockedProperties({ data, storedLockedProperties, isModerator });

  // Re-expanded from the OWNER's rows rather than trusted from the client, and before the write
  // so what is stored is what the blurb actually says — and before the profanity filter below,
  // which must evaluate the text that will actually be published. A moderator saving someone
  // else's model resolves none of their blurbs, so they get the ids the model already
  // references instead of stripping every span.
  const ownerId = beforeUpdate?.userId ?? userId;
  const restrictToBlurbIds =
    beforeUpdate && ownerId !== userId
      ? () => getReferencedBlurbIds({ entityType: 'Model', entityId: id as number })
      : undefined;
  // Whether the CALLER supplied the column, captured before the expansion overwrites it below.
  // A write that omits `description` — the review handlers select without it — must not
  // reconcile: Prisma leaves the column alone, so an empty expansion would delete every
  // reference row while the blurb markup stays in the body, stranding it permanently.
  const descriptionSupplied = data.description != null;
  const expansion = await expandBlurbs({
    userId: ownerId,
    html: data.description ?? '',
    restrictToBlurbIds,
  });
  if (descriptionSupplied) {
    data.description = expansion.html;
    // The guard at the top of this function saw the CLIENT's html. Blurb bodies were spliced in
    // since, so the string about to be written is one it never checked.
    await throwOnBlockedUserContent(data.description, { isModerator, surface: 'model' });
  }

  let profanityAutoNsfw = false;
  if (!isModerator) {
    // Check model name and description for profanity using threshold-based evaluation
    const profanityFilter = createProfanityFilter();
    const textToCheck = [data.name, data.description].filter(Boolean).join(' ');
    const evaluation = profanityFilter.evaluateContent(textToCheck);

    if (evaluation.shouldMarkNSFW && !data.nsfw) {
      meta = {
        ...(meta ?? {}),
        profanityMatches: evaluation.matchedWords,
        profanityEvaluation: {
          reason: evaluation.reason,
          metrics: evaluation.metrics,
        },
      };
      // A stored nsfw lock is a moderator's call (minor-flagging sets it false): keep the
      // detection for review, but never let the filter overturn it.
      if (!storedLockedProperties.includes('nsfw')) {
        data.nsfw = true;
        data.lockedProperties = uniq([...storedLockedProperties, 'nsfw']);
        profanityAutoNsfw = true;
      }
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
    const result = await dbWrite.$transaction(
      async (tx) => {
        const created = await tx.model.create({
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

        if (descriptionSupplied && expansion.evaluated)
          await reconcileBlurbReferences({
            entityType: 'Model',
            entityId: created.id,
            uses: expansion.uses,
            tx,
          });

        return created;
      },
      { maxWait: 10000, timeout: 30000 }
    );

    const modelMeta = result.meta as ModelMeta | null;
    if (modelMeta?.showcaseCollectionId) {
      // Best-effort — model create should not fail if the showcase collection
      // can't be written to (e.g. user references one they don't own).
      await saveItemInCollections({
        input: {
          collections: [{ collectionId: modelMeta.showcaseCollectionId }],
          modelId: result.id,
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
    }

    await modelTagCache.refresh(result.id);
    // Model tag set changed → the votable-tags list (score>0 ModelTag rows) changed too.
    await modelVotableTagsCache.bust(result.id);
    await preventReplicationLag('model', result.id);
    if (data.uploadType === ModelUploadType.Trained) {
      // getTrainingModelsByUserId filters by userId — flag that path so the
      // dashboard refresh right after create reads from primary.
      await preventReplicationLag('userTrainingModels', userId);
    }

    // Fire-and-forget: the helper owns its own flag check and swallows its own errors, so a
    // moderation outage can never fail a model save.
    submitModelTextModeration({
      id: result.id,
      name: data.name,
      description: data.description,
      isModerator,
    }).catch(() => null);

    return { ...result, meta: stripMinorHashMeta(modelMeta) };
  } else {
    if (!beforeUpdate) return null;

    const isOwner = beforeUpdate.userId === userId || isModerator;
    if (!isOwner) return null;

    const prevGallerySettings = beforeUpdate.gallerySettings as ModelGallerySettingsSchema;
    const prevMeta = beforeUpdate.meta as ModelMeta | null;

    let clearedLicensingSources: { id: number; licensingSourceVersionId: number }[] = [];
    let typeBeforeUpdate: ModelType | undefined;

    const result = await dbWrite.$transaction(
      async (tx) => {
        // Not `beforeUpdate.type` — that is a `dbRead` read, and a stale replica reads as "type
        // unchanged", skipping the repair below on exactly the save that needed it.
        typeBeforeUpdate = (await tx.model.findUnique({ where: { id }, select: { type: true } }))
          ?.type;

        const updated = await tx.model.update({
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
            type: true,
          },
          where: { id },
          data: {
            ...data,
            meta: { ...prevMeta, ...meta },
            gallerySettings: {
              ...prevGallerySettings,
              level:
                input.minor || input.sfwOnly ? sfwBrowsingLevelsFlag : prevGallerySettings?.level,
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

        // The same lineage rule `upsertModelVersionHandler` coerces on a version write, applied to
        // the other write that can break the pairing: the model's type (CU 868kwf2fd).
        //
        // Inside the transaction: a reader between the type change and the repair would price
        // generations against a lineage the model no longer supports.
        //
        // 🔴 Gate on the type CHANGING, not on the payload carrying one: `type` is required by
        // `modelUpsertSchema`, so `data.type !== undefined` is true on every save — a rename, a
        // tag edit.
        if (updated.type !== typeBeforeUpdate) {
          const stamped = await tx.modelVersion.findMany({
            where: { modelId: updated.id, licensingSourceVersionId: { not: null } },
            select: { id: true, baseModel: true, licensingSourceVersionId: true },
          });
          // Type-narrowing only; the `where` above already excludes nulls.
          const stampedWithSource = stamped.filter(
            (v): v is typeof v & { licensingSourceVersionId: number } =>
              v.licensingSourceVersionId != null
          );
          if (stampedWithSource.length) {
            const roots = await tx.licensingRoot.findMany({
              where: {
                modelVersionId: {
                  in: uniq(stampedWithSource.map((v) => v.licensingSourceVersionId)),
                },
              },
              select: { modelVersionId: true, baseModel: true, modelType: true },
            });
            const rootByVersionId = new Map(roots.map((r) => [r.modelVersionId, r]));
            clearedLicensingSources = stampedWithSource
              .filter((v) => {
                const root = rootByVersionId.get(v.licensingSourceVersionId);
                return !root || root.baseModel !== v.baseModel || root.modelType !== updated.type;
              })
              .map((v) => ({
                id: v.id,
                licensingSourceVersionId: v.licensingSourceVersionId,
              }));
            if (clearedLicensingSources.length)
              await tx.modelVersion.updateMany({
                where: { id: { in: clearedLicensingSources.map((v) => v.id) } },
                data: { licensingSourceVersionId: null },
              });
          }
        }

        if (descriptionSupplied && expansion.evaluated)
          await reconcileBlurbReferences({
            entityType: 'Model',
            entityId: updated.id,
            uses: expansion.uses,
            tx,
          });

        return updated;
      },
      { maxWait: 10000, timeout: 30000 }
    );
    await preventReplicationLag('model', id);
    await userModelCountCache.refresh(userId);

    if (tracker) {
      const changeRows = diffEntityChanges({
        entityType: 'Model',
        entityId: id as number,
        ownerId: beforeUpdate.userId,
        // `type` off the transaction's own read, not the `dbRead` one beside it: a stale replica
        // reads as "type unchanged" and emits no row, on exactly the save whose fee clears need
        // explaining. Same reason the repair above does not use `beforeUpdate.type`.
        before: { ...beforeUpdate, type: typeBeforeUpdate ?? beforeUpdate.type },
        after: data as Record<string, unknown>,
        actorRole: resolveActorRole({
          actorUserId: userId,
          ownerId: beforeUpdate.userId,
          isModerator,
        }),
        systemFields: profanityAutoNsfw
          ? { nsfw: 'profanity-filter', lockedProperties: 'profanity-filter' }
          : undefined,
      });
      tracker.entityChanges(changeRows).catch(() => null);
    }

    if (clearedLicensingSources.length) {
      // `systemFields` attributes the clear to the rule, not the owner, who changed a type, not a fee.
      const actorRole = resolveActorRole({
        actorUserId: userId,
        ownerId: beforeUpdate.userId,
        isModerator,
      });
      if (tracker)
        tracker
          .entityChanges(
            clearedLicensingSources.flatMap((v) =>
              diffEntityChanges({
                entityType: 'ModelVersion',
                entityId: v.id,
                ownerId: beforeUpdate.userId,
                before: { licensingSourceVersionId: v.licensingSourceVersionId },
                after: { licensingSourceVersionId: null },
                actorRole,
                systemFields: { licensingSourceVersionId: 'model-type-changed' },
              })
            )
          )
          .catch(() => null);
      logToAxiom({
        name: 'model-version-licensing-source-cleared',
        type: 'info',
        reason: 'model-type-changed',
        userId,
        modelId: result.id,
        modelType: result.type,
        modelVersionIds: clearedLicensingSources.map((v) => v.id),
      }).catch(() => null);
      // Flag lag BEFORE the bust (as publishModelById does): otherwise a concurrent read inside the
      // replication window refills these caches from the replica's pre-clear row and the fee stays
      // live. A type change already busts every version id below — the ordering is what this adds.
      const clearedVersionIds = clearedLicensingSources.map((v) => v.id);
      await preventModelVersionLagBatch(result.id, clearedVersionIds);
      await bustMvCache(clearedVersionIds, result.id, userId).catch(() => undefined);
    }

    const modelMeta = result.meta as ModelMeta | null;
    const showcaseCollectionChanged =
      modelMeta?.showcaseCollectionId !== (beforeUpdate.meta as ModelMeta)?.showcaseCollectionId;

    await applyModelFlagSideEffects({
      before: beforeUpdate,
      after: result,
      tagsChanged: !!tagsOnModels,
    });

    // GenerationCoverage is a view over these columns, but the orchestrator holds its own copy of
    // each resource: without this, a creator who adds RentCivit is told the model is "not enabled
    // for generation" until something else makes the orchestrator refetch. bustMvCache wraps
    // bustOrchestratorModelCache plus the resource-data/data-for-model/search-index busts that read
    // `covered` too. Never rejects — the write has already committed.
    const coverageChanged = coverageModelFields.some(
      (field) =>
        data[field] !== undefined &&
        stableStringify(data[field]) !== stableStringify(beforeUpdate[field])
    );
    if (coverageChanged) {
      const versions = await dbWrite.modelVersion.findMany({
        where: { modelId: result.id },
        select: { id: true },
      });
      if (versions.length)
        await bustMvCache(
          versions.map((v) => v.id),
          result.id,
          userId
        ).catch(() => undefined);
    }

    if (showcaseCollectionChanged) {
      if (modelMeta?.showcaseCollectionId) {
        await saveItemInCollections({
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

    // Drop the origin-side public GET /api/v1/models/[id] response cache so an
    // owner/mod edit (name/description/nsfw/tags/gallery — all carried in the
    // cached body) stops serving a stale 200 on an edge-miss for up to the cache
    // TTL. preventReplicationLag('model', id) above already guards the rebuild
    // read against the replication window. Fail-open (the helper swallows Redis
    // errors).
    await bustPublicModelResponseCache(result.id);

    // Skipped when neither field moved. contentHash dedup would drop the moderation submit
    // anyway, but only after a round trip and an EntityModeration upsert on every unrelated
    // model edit. `result` carries the post-update values, not `beforeUpdate`'s.
    if (result.name !== beforeUpdate.name || result.description !== beforeUpdate.description) {
      await applyModelContentChange({
        id: result.id,
        description: result.description ?? '',
        context: { name: result.name, isModerator },
      });
    }

    return withoutMinorHashMeta(result);
  }
};

/**
 * The one path for "a model's description changed": the column write plus the follow-up that
 * change implies. `upsertModel` calls it, and so does the blurb fan-out — which is what stops
 * the two drifting.
 *
 * Deliberately narrow. `upsertModel` is form-shaped, so a caller holding only new HTML cannot
 * use it without clearing tags, gallery settings and the whole licensing block. `updateModelById`
 * is not the answer either: it takes an arbitrary Prisma update and runs neither the moderation
 * submit nor the response-cache bust below.
 */
export async function applyModelContentChange({
  id,
  description,
  context,
  expectedDescription,
}: {
  id: number;
  description: string;
  /**
   * Compare-and-set: the body this caller READ before splicing. The fan-out does load → splice →
   * save with nothing held across it, so a creator saving in that window had their edit silently
   * reverted by the replay — no error, and the save it clobbered had already returned success.
   * Supplied, a mismatch writes nothing and returns false; the reference stays pending and the
   * next pass re-reads. Omitted, the write is unconditional as before.
   */
  expectedDescription?: string;
  /**
   * A caller that has ALREADY written this body passes its post-write snapshot here. Delete it
   * from such a call site and the write below replays the body over a save that committed in
   * between.
   */
  context?: { name: string; isModerator?: boolean };
}) {
  // The blocklist can move after a blurb was saved, and the fan-out has no user in the loop to
  // catch it — same reason `applyArticleContentChange` re-checks.
  await throwOnBlockedUserContent(description, { surface: 'model' });

  let resolved = context;
  if (!resolved) {
    const stored = await dbWrite.model.findUnique({
      where: { id },
      select: { name: true, nsfw: true, lockedProperties: true, meta: true },
    });
    if (!stored) throw throwNotFoundError(`No model with id ${id}`);
    resolved = { name: stored.name };

    // Raw SQL because Prisma's @updatedAt fires on every client-side update(), and a blurb
    // re-materialization is not a creator edit: `updatedAt` orders the "recently updated"
    // model lists.
    const affected =
      await dbWrite.$executeRaw`UPDATE "Model" SET description = ${description} WHERE id = ${id}${
        expectedDescription === undefined
          ? Prisma.empty
          : Prisma.sql` AND description = ${expectedDescription}`
      }`;
    if (expectedDescription !== undefined && !affected) return false;
    await preventReplicationLag('model', id);

    // A caller passing `context` has already written the body AND already run this gate on it.
    // This branch is the fan-out, which has neither — and the text it just wrote is text the
    // upsert's gate never saw. Without this, editing a blurb is a way to put profanity into a
    // published description while it keeps the SFW classification it earned with the old text.
    const flagged = evaluateAutoNsfw({
      name: stored.name,
      description,
      alreadyNsfw: stored.nsfw,
      lockedProperties: stored.lockedProperties,
    });
    if (flagged) {
      const meta = {
        ...((stored.meta as MixedObject | null) ?? {}),
        ...flagged.metaPatch,
      } as Prisma.InputJsonObject;
      // Prisma rather than raw SQL, unlike the body write above: this fires rarely, and hand-
      // rolling the jsonb + text[] binds is where that trade stops being worth it. The
      // `updatedAt` bump it carries is honest — the model's rating actually changed.
      await dbWrite.model.update({
        where: { id },
        data: flagged.lock
          ? { nsfw: true, lockedProperties: uniq([...stored.lockedProperties, 'nsfw']), meta }
          : { meta },
      });
    }
  }

  // The description is carried in the cached public GET /api/v1/models/[id] body, so without
  // this an edge-miss keeps serving the pre-rewrite text for up to the cache TTL. Fail-open
  // (the helper swallows Redis errors).
  //
  // Only when nobody handed us a `context`: a caller that passes one has already written the
  // body, and `upsertModel` busts unconditionally a few lines before it calls this — so doing it
  // here too was a second identical bust on every content-changing model save.
  if (!context) await bustPublicModelResponseCache(id);

  // Fire-and-forget: the helper owns its own flag check and swallows its own errors, so a
  // moderation outage can never fail a model save.
  submitModelTextModeration({
    id,
    name: resolved.name,
    description,
    isModerator: resolved.isModerator,
  }).catch(() => null);

  return true;
}

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
  if (meta?.cannotPublish) {
    throw throwBadRequestError('This model cannot be published due to moderation restrictions.');
  }
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

      // Anti-bump guard: publishedAt is immutable once a model has gone
      // public. Allowed transitions: NULL (Draft) -> set, or future
      // (Scheduled) -> reschedule. Republish of an already-public model is a
      // no-op for this column. Mirrors the Post guard below.
      await tx.$executeRaw`
        UPDATE "Model"
        SET "publishedAt" = ${publishedAt}
        WHERE id = ${id}
        AND ("publishedAt" IS NULL OR "publishedAt" > NOW())
      `;

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

      // Check if any of the versions being published use deprecated base models
      if (includeVersions) {
        const versionsToPublish = model.modelVersions.filter((version) =>
          versionIds.includes(version.id)
        );
        const hasDeprecatedBaseModel = versionsToPublish.some((version) =>
          DEPRECATED_BASE_MODELS.includes(version.baseModel as any)
        );
        if (hasDeprecatedBaseModel) {
          throw throwBadRequestError(
            `Cannot publish models with versions using deprecated base models: ${DEPRECATED_BASE_MODELS.join(
              ', '
            )}`
          );
        }
      }

      if (includeVersions) {
        if (status === ModelStatus.Published) {
          // Publish model versions with early access check. Anti-bump guard
          // for ModelVersion.publishedAt lives inside this call.
          await publishModelVersionsWithEarlyAccess({
            modelVersionIds: versionIds,
            publishedAt,
            tx,
          });
        } else if (status === ModelStatus.Scheduled) {
          // Schedule model versions. Status flips unconditionally, but
          // publishedAt only flips while the row is mutable (Draft or
          // future-Scheduled) — anti-bump guard via raw SQL.
          await tx.modelVersion.updateMany({
            where: { id: { in: versionIds } },
            data: { status },
          });
          await tx.$executeRaw`
            UPDATE "ModelVersion"
            SET "publishedAt" = ${publishedAt}
            WHERE id IN (${Prisma.join(versionIds, ',')})
            AND ("publishedAt" IS NULL OR "publishedAt" > NOW())
          `;
        }

        // Restore posts that were unpublished alongside the model, and re-target
        // posts that are still scheduled (future publishedAt) so a reschedule of
        // the model also reschedules its attached posts. The `publishedAt <= NOW()`
        // exclusion preserves the anti-bump guard for already-public posts —
        // without it, calling publish on an already-published model would
        // overwrite every attached post's publishedAt and let an owner repeatedly
        // bump old posts to the top of feeds. Mirrors the unpublish path's
        // `WHERE "publishedAt" IS NOT NULL`.
        await tx.$executeRaw`
          UPDATE "Post" p
          SET "publishedAt" = CASE
                                WHEN p."metadata" ->> 'prevPublishedAt' IS NOT NULL
                                  THEN (p."metadata" ->> 'prevPublishedAt')::timestamptz
                                ELSE mv."publishedAt"
            END,
              "metadata"    = p."metadata" - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt'
          FROM "ModelVersion" mv
          WHERE mv.id = p."modelVersionId"
            AND p."userId" = ${model.userId}
            AND p."modelVersionId" IN (${Prisma.join(versionIds, ',')})
            AND (p."publishedAt" IS NULL OR p."publishedAt" > NOW())
        `;
      }
      if (!republishing && !meta?.unpublishedBy) await updateModelLastVersionAt({ id, tx });

      return model;
    },
    { timeout: 10000 }
  );

  // Flag replica-lag BEFORE any post-commit reader runs so lag-aware lookups
  // (dataForModelsCache.lookupFn, getDbWithoutLag) route to primary during the
  // replication window — otherwise a concurrent feed read can poison
  // dataForModelsCache with the pre-publish version state.
  const allVersionIds = model.modelVersions.map((x) => x.id);
  await preventModelVersionLagBatch(model.id, allVersionIds);

  await userModelCountCache.refresh(model.userId);

  if (includeVersions && status !== ModelStatus.Scheduled) {
    await bustMvCache(allVersionIds, model.id);
  }

  // Fetch affected posts to update their images in search index. Use dbWrite —
  // these run immediately after publish commit and the replica may not yet
  // have the post/image rows (especially when post + version are written in
  // the same publish flow), which would silently drop them from the
  // search-index update batch.
  const posts = await dbWrite.post.findMany({
    where: { modelVersionId: { in: allVersionIds }, userId: model.userId },
    select: { id: true },
  });
  const images = await dbWrite.image.findMany({
    where: { postId: { in: posts.map((x) => x.id) } },
    select: { id: true },
  });

  // Republish only: a dropped Update on this path has no recovery without an updatedAt bump (both
  // image indexes re-derive a missing Update solely from a delta scan of moved rows, and a
  // republish otherwise never touches the image rows — see buildRepublishImageIndexTouch). A
  // first/scheduled publish's images were just created, so they carry a fresh updatedAt the delta
  // scan already sees; bumping thousands of rows there is pure duplicate work against the direct
  // queueUpdate below.
  if (republishing && allVersionIds.length > 0) {
    await dbWrite.$executeRaw(
      buildRepublishImageIndexTouch({ userId: model.userId, versionIds: allVersionIds })
    );
  }

  // Update search index for model
  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);
  // Update search index for all affected images
  await imagesSearchIndex.queueUpdate(
    images.map((x) => ({ id: x.id, action: SearchIndexUpdateQueueAction.Update }))
  );
  await imagesMetricsSearchIndex.queueUpdate(
    images.map((x) => ({ id: x.id, action: SearchIndexUpdateQueueAction.Update }))
  );

  return model;
};

import {
  getModelEarlyAccessRefundRequirement,
  refundModelEarlyAccessPurchases,
} from '~/server/services/model-early-access-refund.service';

// Re-exported for the callers that predate the extraction. The version-scoped entry point is
// deliberately NOT re-exported here — reaching it through this module is what would put the
// model-version → model import edge back.
export { getModelEarlyAccessRefundRequirement } from '~/server/services/model-early-access-refund.service';
export type { ModelEarlyAccessRefundRequirement } from '~/server/services/model-early-access-refund.service';

export const unpublishModelById = async ({
  id,
  reason,
  customMessage,
  refundEarlyAccess,
  meta,
  userId,
  isModerator,
}: UnpublishModelSchema & {
  meta?: ModelMeta;
  userId: number;
  isModerator?: boolean;
}) => {
  if (!isModerator) {
    // The guard below reasons from "an owner-initiated unpublish carries no reason". `reason` is a
    // plain optional input, so without this that is an assumption rather than a precondition: an
    // owner supplying one takes the non-preserve branch and overwrites the moderator's verdict,
    // explanation and attribution — no republish escape, but the record destroyed by the person it
    // is against, and the take-down notification re-fired.
    if (reason || customMessage)
      throw throwAuthorizationError('Only a moderator can give a reason for unpublishing.');

    const requirement = await getModelEarlyAccessRefundRequirement({ id });
    if (requirement.purchases.length > 0) {
      if (!refundEarlyAccess) {
        throw throwBadRequestError(
          `Cannot unpublish a model with active early access purchases without refunding buyers. ${requirement.buyerCount} member(s) must be refunded a total of ${requirement.totalBuzz} Buzz.`
        );
      }
      await refundModelEarlyAccessPurchases({ modelId: id, requirement });
    }
  }

  const model = await dbWrite.$transaction(
    async (tx) => {
      // 🔴 Never write a moderator's verdict down. A reasonless unpublish — every owner-initiated
      // one — would otherwise overwrite an existing UnpublishedViolation with plain Unpublished and
      // restamp the record, and `model.controller.ts` blocks an owner republish only WHILE the
      // status is UnpublishedViolation. That is an owner-reachable way to clear a moderation flag.
      //
      // Decided from the STATUS, not from `meta.unpublishedReason`: 2,327 of 43,492 violation rows
      // in prod carry no reason in meta, and keying on meta fails open for exactly those. The
      // moderator's explanation, timestamp and actor are all left untouched — refreshing
      // `unpublishedAt` alone re-fires the take-down notification, and `customMessage` is the ONLY
      // explanation rendered when the reason is 'other', which is the largest bucket.
      const existing = await tx.model.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      });
      // Any moderator-only status, not UnpublishedViolation alone: Deleted is the other one, and
      // clearing it lets an owner republish a soft-deleted model.
      const preserveModStatus =
        !reason && constants.modPublishOnlyStatuses.includes(existing.status);

      const unpublishedAt = new Date().toISOString();
      const updatedMeta = preserveModStatus
        ? meta
        : {
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
          status: reason
            ? ModelStatus.UnpublishedViolation
            : preserveModStatus
            ? existing.status
            : ModelStatus.Unpublished,
          meta: updatedMeta,
        },
        select: { userId: true, modelVersions: { select: { id: true } } },
      });

      const versionIds = updatedModel.modelVersions.map((x) => x.id);

      // One statement for the version take-down, and it has to stay one.
      //
      // 🔴 MERGE the keys into each version's own meta rather than writing an object over the
      // column. Overwriting replaced every version's meta wholesale and `hadEarlyAccessPurchase`
      // went with it — that flag is the only pre-filter on the refund requirement and the guard on
      // both delete paths, so losing it turns an unpublish into a way to shed the refund obligation
      // and then delete the version past every guard. `updateMany` cannot write a different value
      // per row, hence raw SQL.
      //
      // On a preserved take-down the status follows the model but the NARRATIVE does not: merging
      // unpublishedAt into version meta re-fires the per-version notification —
      // unpublish.notifications.ts selects on that meta with no status predicate — naming the owner
      // as the actor of a moderator's decision.
      //
      // 🔴 And the keys must land on exactly the versions this call takes down. They are what
      // unpublish.notifications.ts selects on — meta alone, no status predicate, keyed per version —
      // so stamping a draft tells the creator a version they never published was unpublished.
      // Status and meta move together under one snapshot, which makes "stamped iff transitioned"
      // structural rather than two predicates someone has to keep in step.
      await tx.$executeRaw`
        UPDATE "ModelVersion"
        SET "status" = ${
          reason
            ? ModelStatus.UnpublishedViolation
            : preserveModStatus
            ? existing.status
            : ModelStatus.Unpublished
        }::"ModelStatus",
            "meta" = COALESCE("meta", '{}'::jsonb) || ${JSON.stringify(
              preserveModStatus
                ? {}
                : {
                    ...(reason ? { unpublishedReason: reason, customMessage } : {}),
                    unpublishedAt,
                    unpublishedBy: userId,
                  }
            )}::jsonb,
            -- Prisma's @updatedAt does not apply to raw SQL, and there is no DB default or trigger.
            -- Without this a taken-down version keeps a pre-take-down updatedAt, which is on the
            -- public v1 payload via modelVersion.selector.
            "updatedAt" = NOW()
        WHERE "modelId" = ${id}
          AND "status" IN (${ModelStatus.Published}::"ModelStatus", ${
        ModelStatus.Scheduled
      }::"ModelStatus")
      `;

      // Deliberately the WIDE id list, unlike the statement above: a post attached to a version that
      // was already down can still be published, and `publishedAt IS NOT NULL` is what scopes this —
      // not the id set. Narrowing it to the versions this call took down would leave those posts public.
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

      return updatedModel;
    },
    { timeout: 30000, maxWait: 10000 }
  );

  // Flag replica-lag and refresh feed-side caches so the unpublished model
  // disappears from feeds and the model page reflects the new status without
  // waiting for cache TTL.
  const allVersionIds = model.modelVersions.map((x) => x.id);
  await preventModelVersionLagBatch(id, allVersionIds);
  await bustMvCache(allVersionIds, id);
  await userModelCountCache.refresh(model.userId);

  // Use dbWrite for the search-index lookups for the same reason as
  // publishModelById — the replica may not yet reflect the txn we just
  // committed.
  try {
    const posts = await dbWrite.post.findMany({
      where: { modelVersionId: { in: allVersionIds }, userId: model.userId },
      select: { id: true },
    });
    const images = await dbWrite.image.findMany({
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
  } catch (error) {
    // Best-effort: the unpublish txn is already committed, so an index-queue
    // hiccup must not throw to the caller and skip the trailing bid cleanup.
    logToAxiom({
      type: 'error',
      name: 'model-unpublish-image-search-index',
      message: `Failed to queue search index update for model ${id}`,
      error,
    });
  }

  await deleteBidsForModel({ modelId: id });

  return model;
};

export const getVaeFiles = async ({ vaeIds }: { vaeIds: number[] }) => {
  const files = (
    await dbRead.modelFile.findMany({
      // No replacedAt/visibility filter needed: only primary `Model` files are read here,
      // and primary files are never quarantined (linked-component replace rejects them).
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
  query,
  trainingStatus,
  baseModel,
  type,
  sort = 'startDesc',
}: GetMyTrainingModelsSchema & {
  userId: number;
  select: TSelect;
}) => {
  const { take, skip } = getPagination(limit, page);

  // Build trainingDetails filters (need AND to combine multiple JSON path filters)
  const trainingDetailsFilters: Prisma.ModelVersionWhereInput[] = [];
  if (baseModel) {
    trainingDetailsFilters.push({
      trainingDetails: {
        path: ['baseModel'],
        equals: baseModel,
      },
    });
  }
  if (type) {
    trainingDetailsFilters.push({
      trainingDetails: {
        path: ['type'],
        equals: type,
      },
    });
  }

  // Build where clause with filters
  const where: Prisma.ModelVersionFindManyArgs['where'] = {
    // Only in-flight trainings. A model that was published then swept (post
    // emptied/deleted -> requirements cron) now comes back as Draft (the cron
    // resets trained versions to Draft, and the one-time backfill did the same
    // for already-swept ones), so it reappears here without surfacing
    // Unpublished — which would otherwise also pull in ToS/moderation removals.
    status: { in: [ModelStatus.Draft, ModelStatus.Training] },
    uploadType: ModelUploadType.Trained,
    model: {
      userId,
      status: { notIn: [ModelStatus.Deleted] },
      ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}),
    },
    ...(trainingStatus && trainingStatus.length > 0
      ? { trainingStatus: { in: trainingStatus } }
      : {}),
    ...(trainingDetailsFilters.length > 0 ? { AND: trainingDetailsFilters } : {}),
  };

  // Determine orderBy based on sort option
  // Note: start/end dates are in file metadata, so we fall back to createdAt/updatedAt for DB sorting
  // The frontend will handle more granular sorting if needed
  let orderBy: Prisma.ModelVersionFindManyArgs['orderBy'];
  switch (sort) {
    case 'startAsc':
    case 'endAsc':
      orderBy = { createdAt: 'asc' };
      break;
    case 'createdAsc':
      orderBy = { createdAt: 'asc' };
      break;
    case 'createdDesc':
      orderBy = { createdAt: 'desc' };
      break;
    case 'updatedAsc':
      orderBy = { updatedAt: 'asc' };
      break;
    case 'updatedDesc':
      orderBy = { updatedAt: 'desc' };
      break;
    case 'startDesc':
    case 'endDesc':
    default:
      orderBy = { createdAt: 'desc' };
      break;
  }

  // Route to primary when the user just wrote to their training models so the
  // list reflects the change. Flag is set by updateModelVersionTrainingStatus
  // and by upsertModel on create-training.
  const db = await getDbWithoutLag('userTrainingModels', userId);
  const [items, count] = await Promise.all([
    db.modelVersion.findMany({
      select,
      skip,
      take,
      where,
      orderBy,
    }),
    db.modelVersion.count({ where }),
  ]);

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
      // ImageResourceNew.modelVersion is a required relation, but orphaned rows
      // exist in prod (modelVersionId pointing at a hard-deleted ModelVersion).
      // Selecting the required relation on such a row makes Prisma throw
      // "Inconsistent query result: Field modelVersion is required ... got null"
      // → HTTP 500. Filtering on relation existence excludes the orphans so the
      // query degrades gracefully (returns the resolvable rows) instead.
      modelVersion: { is: {} },
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
  await userModelCountCache.refresh(model.userId);
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

export const queueModelEarlyAccessReindex = async ({ id }: GetByIdInput) => {
  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);
  await dataForModelsCache.refresh(id);
};

/**
 * Mod-driven "bump" — pushes a model to the top of the Newest feed by
 * setting `lastVersionAt = NOW()`. Invalidates the caches that drive feed
 * ordering and search.
 *
 * Note: this currently re-qualifies the model for the external `updated-model`
 * webhook fan-out (see `src/server/webhooks/model.webooks.ts`). Per product
 * decision, bumps are intended to be a maintenance action and should not
 * notify webhook subscribers — suppressing that fan-out cleanly requires
 * either a per-model `bumpedAt` column or a webhook predicate change. Tracking
 * as a follow-up; the current fan-out side-effect is acceptable for Phase 1.
 */
export async function bumpModel({ id }: { id: number }) {
  const updated = await dbWrite.model.update({
    where: { id },
    data: { lastVersionAt: new Date() },
    select: { id: true, userId: true, lastVersionAt: true },
  });

  await Promise.all([
    dataForModelsCache.refresh([id]),
    modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]),
    userModelCountCache.refresh(updated.userId),
  ]);

  return updated;
}

export async function updateModelLastVersionAt({
  id,
  tx,
}: {
  id: number;
  tx?: Prisma.TransactionClient;
}) {
  const dbClient = tx ?? dbWrite;

  // lte: NOW() — never propagate a future publishedAt into lastVersionAt;
  // a future value pins the model to the top of the Newest feed.
  const modelVersion = await dbClient.modelVersion.findFirst({
    where: {
      modelId: id,
      status: ModelStatus.Published,
      publishedAt: { not: null, lte: new Date() },
    },
    select: { publishedAt: true },
    orderBy: { publishedAt: 'desc' },
  });
  if (!modelVersion) return;

  try {
    const model = await dbClient.model.update({
      where: { id },
      data: { lastVersionAt: modelVersion.publishedAt },
    });

    await userModelCountCache.refresh(model.userId);
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

    await modelTagCache.refresh(modelIds);
    // Applied tags land as score>0 ModelTag rows → refresh the votable-tags cache too.
    await modelVotableTagsCache.bust(modelIds);
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
  ignoreBrowsingAddons,
}: {
  input: GetAllModelsOutput & { take?: number; skip?: number };
  user?: {
    id: number;
    isModerator?: boolean;
    username?: string;
    filePreferences?: UserFilePreferences;
  };
  /** See `getModelsRaw` — by-id lookups opt out of the addon discovery gates. */
  ignoreBrowsingAddons?: boolean;
}) {
  const { items, nextCursor } = await getModelsRaw({
    input,
    user,
    include: ['details'],
    ignoreBrowsingAddons,
  });

  const modelVersionIds = items.flatMap(({ modelVersions }) => modelVersions.map(({ id }) => id));
  const paidAccessMap = await getPublicPaidAccessForModelVersions(modelVersionIds);
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

  // Get VAE version IDs from linked components
  const allMvIds = items.flatMap(({ modelVersions }) => modelVersions.map((v) => v.id));
  const vaeLinkedRows = allMvIds.length
    ? await dbRead.recommendedResource.findMany({
        where: {
          sourceId: { in: allMvIds },
          settings: { path: ['isLinkedComponent'], equals: true },
        },
        select: { sourceId: true, resourceId: true, settings: true },
      })
    : [];
  const vaeMap = new Map<number, number>();
  for (const row of vaeLinkedRows) {
    const s = row.settings as Record<string, unknown>;
    if (s?.componentType === 'VAE' && row.sourceId) {
      vaeMap.set(row.sourceId, row.resourceId);
    }
  }
  const vaeIds = [...new Set(vaeMap.values())];
  const vaeFiles = vaeIds.length ? await getVaeFiles({ vaeIds }) : [];

  const groupedFiles = await getFilesForModelVersionCache(modelVersionIds);

  const modelIds = items.map(({ id }) => id);
  const metrics = await dbRead.modelMetric.findMany({
    where: { modelId: { in: modelIds } },
  });

  const versionMetrics = await dbRead.modelVersionMetric.findMany({
    where: { modelVersionId: { in: modelVersionIds } },
  });

  // Creator Controls metric privacy for the v1 public API. Only download + tipped
  // are exposed today (no generation count in v1 stats), so we gate what exists.
  const isMod = !!user?.isModerator;
  const viewerId = user?.id;
  const apiOwnerIds = [...new Set(items.map((m) => m.user.id))];
  // Cache-backed per-owner metric-privacy DEFAULT flags — see the feed path above;
  // avoids deserializing every owner's full `settings` blob per request.
  const apiOwnerSettingsMap = await getUserMetricPrivacyDefaultsMap(apiOwnerIds);
  const apiMembershipCandidates = new Set<number>();
  for (const it of items) {
    const ownerId = it.user.id;
    if (isMod || ownerId === user?.id) continue;
    const defHidden = getUserMetricPrivacyDefaults(apiOwnerSettingsMap.get(ownerId));
    if (anyMetricHidden(it.metricPrivacy) || anyMetricHidden(defHidden))
      apiMembershipCandidates.add(ownerId);
  }
  const apiMembershipMap = await getValidCreatorMembershipMap([...apiMembershipCandidates]);

  // Version-level meta isn't carried by dataForModelsCache, so fetch it to honor the
  // version-OR-model-OR-user precedence for v1 version stats (a version-only hide).
  const versionMetaRows = modelVersionIds.length
    ? await dbRead.modelVersion.findMany({
        where: { id: { in: modelVersionIds } },
        select: { id: true, meta: true },
      })
    : [];
  const versionMetaMap = new Map<number, unknown>(versionMetaRows.map((v) => [v.id, v.meta]));

  function getStatsForModel(modelId: number, hidden: HiddenModelMetrics) {
    const stats = metrics.find((x) => x.modelId === modelId);
    return {
      downloadCount: hidden.downloads ? null : stats?.downloadCount ?? 0,
      thumbsUpCount: stats?.thumbsUpCount ?? 0,
      thumbsDownCount: stats?.thumbsDownCount ?? 0,
      commentCount: stats?.commentCount ?? 0,
      tippedAmountCount: hidden.buzz ? null : stats?.tippedAmountCount ?? 0,
    };
  }

  function getStatsForVersion(versionId: number, hidden: HiddenModelMetrics) {
    const stats = versionMetrics.find((x) => x.modelVersionId === versionId);
    return {
      downloadCount: hidden.downloads ? null : stats?.downloadCount ?? 0,
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
        metricPrivacy,
        ...model
      }) => {
        const isOwner = isMod || user.id === viewerId;
        const modelHidden = resolveModelHiddenMetrics({
          modelMeta: {
            hideBuzz: metricPrivacy.buzz,
            hideDownloads: metricPrivacy.downloads,
            hideGenerations: metricPrivacy.generations,
          },
          userSettings: apiOwnerSettingsMap.get(user.id),
          isOwnerOrModerator: isOwner,
          hasValidMembership: apiMembershipMap.get(user.id) ?? false,
        });
        return {
          ...model,
          user: user.username === 'civitai' ? undefined : user,
          supportsGeneration: modelVersions.some((x) => x.covered),
          modelVersions: modelVersions.map(
            ({ trainingStatus, earlyAccessTimeFrame, ...version }) => {
              const versionHidden = resolveVersionHiddenMetrics({
                versionMeta: versionMetaMap.get(version.id),
                modelMeta: {
                  hideBuzz: metricPrivacy.buzz,
                  hideDownloads: metricPrivacy.downloads,
                  hideGenerations: metricPrivacy.generations,
                },
                userSettings: apiOwnerSettingsMap.get(user.id),
                isOwnerOrModerator: isOwner,
                hasValidMembership: apiMembershipMap.get(user.id) ?? false,
              });
              const stats = getStatsForVersion(version.id, versionHidden);
              const vaeVersionId = vaeMap.get(version.id);
              const vaeFile = vaeVersionId
                ? vaeFiles.filter((x) => x.modelVersionId === vaeVersionId)
                : [];
              // Build a NEW array rather than pushing onto the cached record's own. The cache
              // layer shallow-clones records and documents nested fields as read-only, and its
              // fail-open degraded path hands one shared `files` array to every concurrent
              // reader of that version — a `push` here would leak this VAE into other in-flight
              // requests (and, via the 180s origin response cache on
              // `src/pages/api/v1/models/[id].ts`, into every later reader of that model id).
              // The next statement rebuilds the list with `.map()` anyway, so nothing downstream
              // wanted the mutation.
              const files = [...(groupedFiles[version.id]?.files ?? []), ...vaeFile];

              // `earlyAccessTimeFrame` is dead — no write path has touched it since the PaidAccess
              // cutover, so the deadline has to come from PaidAccess.
              const paidAccess = paidAccessMap[version.id] ?? null;
              const earlyAccessDeadline = paidAccess?.endsAt ?? undefined;

              return {
                ...version,
                // `modelVersionId` is deliberately PRESERVED on each file. The
                // `files.push(...vaeFile)` above splices in files that live on
                // the LINKED VAE version, so "which version owns this file" is
                // not derivable from the enclosing `version.id` — and the v1
                // response shapers need it to decide whether a per-file
                // `downloadUrl` may be pinned with `fileId` (see
                // createSerializedFileDownloadUrl). Dropping it here is what let
                // a VAE file's id be paired with the host version, producing a
                // 404 on a previously-working URL. Both public consumers
                // (api/v1/models/[id], model-search.service) strip it from the
                // wire body, so the public shape is unchanged.
                files: files.map(toApiModelFile),
                earlyAccessDeadline,
                paidAccess,
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
          stats: getStatsForModel(model.id, modelHidden),
        };
      }
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

    // Merge in Postgres, over the stored column. Writing the whole blob back from a JS
    // snapshot replaced every other settings key with its read-time value, discarding
    // anything that landed in between.
    await patchUserSettings(
      userId,
      { mergeInto: { gallerySettings: settings }, location: 'model.service:updateGallerySettings' },
      tx
    );

    // Flagged models keep the SFW level a moderator forced on them — otherwise one
    // "copy to all my models" re-opens every model the user has ever had flagged.
    await tx.$executeRaw`
      UPDATE "Model"
      SET "gallerySettings" = "gallerySettings" || jsonb_build_object(
        'level', CASE WHEN minor OR "sfwOnly" THEN ${sfwBrowsingLevelsFlag} ELSE ${
      settings.level
    } END,
        'users', ${JSON.stringify(settings.users || [])}::jsonb,
        'tags', ${JSON.stringify(settings.tags || [])}::jsonb
                                                   )
      WHERE
        "userId" = ${userId}
    `;
  });

  // Count-cache refresh hits Redis — run after commit, off the txn budget. Same for the
  // user-settings cache, which this path never busted at all: `getUserSettings` went on
  // serving pre-copy gallery defaults for up to its 4h TTL, and the next whole-blob
  // writer then persisted that stale snapshot.
  await Promise.all([userModelCountCache.refresh(userId), bustUserSettings(userId)]);

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

  await dataForModelsCache.refresh(updated.id);

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
    dataForModelsCache.refresh(modelIds),
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
              select: {
                modelId: true,
                baseModel: true,
                model: { select: { type: true } },
              },
            },
          },
          orderBy: { position: 'asc' },
        });
        if (data.length === 0) {
          retries++;
        } else {
          return data.map((row) => ({
            modelId: row.modelVersion.modelId,
            position: row.position,
            baseModel: row.modelVersion.baseModel as BaseModel,
            type: row.modelVersion.model.type,
          }));
        }
      }

      // if nothing found, get from the collection
      const query = await dbWrite.$queryRaw<{ modelId: number; baseModel: string; type: string }[]>`
        SELECT
          ci."modelId",
          mv."baseModel",
          m."type"
        FROM "CollectionItem" ci
        JOIN "Model" m ON m.id = ci."modelId"
        JOIN "ModelVersion" mv ON mv."modelId" = m.id
        WHERE
          ci."collectionId" = ${FEATURED_MODEL_COLLECTION_ID}
          AND mv.status = 'Published'
        ORDER BY ci."createdAt" desc, mv."createdAt" desc
        LIMIT 500
      `;
      return query.map((row) => ({
        modelId: row.modelId,
        position: 0,
        baseModel: row.baseModel as BaseModel,
        type: row.type as ModelType,
      }));
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

// Mod-only read of a model's moderation state — surfaces why a model is
// locked / marked nsfw / hidden so mods can self-triage instead of escalating
// (auto-actions like the profanity nsfw-lock are otherwise invisible to them).
export async function getModelModerationDetail({ id }: { id: number }) {
  const model = await dbRead.model.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      nsfw: true,
      nsfwLevel: true,
      status: true,
      availability: true,
      minor: true,
      poi: true,
      lockedProperties: true,
      deletedAt: true,
      deletedBy: true,
      meta: true,
    },
  });
  if (!model) throw throwNotFoundError(`No model with id ${id}`);

  const meta = (model.meta ?? {}) as ModelMeta;
  return {
    id: model.id,
    name: model.name,
    nsfw: model.nsfw,
    nsfwLevel: model.nsfwLevel,
    status: model.status,
    availability: model.availability,
    minor: model.minor,
    poi: model.poi,
    lockedProperties: model.lockedProperties ?? [],
    cannotPromote: meta.cannotPromote ?? false,
    cannotPublish: meta.cannotPublish ?? false,
    commentsLocked: meta.commentsLocked ?? false,
    deletedAt: model.deletedAt,
    deletedBy: model.deletedBy,
    profanity: meta.profanityMatches?.length
      ? {
          matches: meta.profanityMatches,
          reason: meta.profanityEvaluation?.reason ?? null,
          metrics: meta.profanityEvaluation?.metrics ?? null,
        }
      : null,
    textModeration: meta.textModeration ?? null,
    unpublishedAt: meta.unpublishedAt ?? null,
    unpublishedBy: meta.unpublishedBy ?? null,
    unpublishedReason: meta.unpublishedReason ?? null,
    takenDownAt: meta.takenDownAt ?? null,
    takenDownBy: meta.takenDownBy ?? null,
    needsReview: meta.needsReview ?? false,
  };
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
    where: {
      userId,
      availability: Availability.Private,
      status: { not: ModelStatus.Deleted },
      deletedAt: null,
    },
  });
};

export const privateModelFromTraining = async ({
  modelVersionIds,
  ...input
}: PrivateModelFromTrainingInput & {
  user: SessionUser; // @luis: Against this personally, but the way createPostImage is implemented requires this.
}) => {
  const { id, tagsOnModels, user, templateId, bountyId, meta, status, ...data } = input;

  const model = await dbRead.model.findUnique({
    where: { id },
    select: {
      userId: true,
      lockedProperties: true,
    },
  });

  if (!model) return null;

  const isOwner = model.userId === user.id || user.isModerator;
  if (!isOwner) return null;

  enforceLockedProperties({
    data,
    storedLockedProperties: model.lockedProperties,
    isModerator: user.isModerator,
  });

  const totalPrivateModels = await dbRead.model.count({
    where: {
      userId: input.user.id,
      availability: Availability.Private,
      status: ModelStatus.Published,
    },
  });

  const subscription = await getHighestTierSubscription(input.user.id);

  const maxPrivateModels = subscription?.tier
    ? constants.memberships.membershipDetailsAddons[
        subscription.tier as keyof typeof constants.memberships.membershipDetailsAddons
      ]?.maxPrivateModels ?? 0
    : 0;

  if (totalPrivateModels >= maxPrivateModels) {
    throw throwBadRequestError('You have reached the maximum number of private models');
  }

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
        meta: {
          ...((meta as ModelMeta) ?? {}),
          // Makes it so these models cannot go into auctions or be promoted
          cannotPromote: true,
        },
        availability: Availability.Private,
        status: ModelStatus.Published,
        sfwOnly: true, // Private models only allow sfw generation
      },
    });

    if (result.modelVersions.length > 0) {
      const now = new Date();

      // Make this private:
      await dbWrite.modelVersion.updateMany({
        where: { modelId: id },
        data: {
          // availability: Availability.Private, -- moved to second updateMany
          publishedAt: now,
          status: ModelStatus.Published,
        },
      });

      // Do this after the fact to avoid some triggers.
      await dbWrite.modelVersion.updateMany({
        where: { modelId: id },
        data: {
          availability: Availability.Private,
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
    await userModelCountCache.refresh(user.id);
    await dataForModelsCache.refresh(id);
    await bustMvCache(
      result.modelVersions.map((x) => x.id),
      result.id
    );

    return withoutMinorHashMeta(result);
  } catch (error) {
    await dbWrite.model.update({
      where: { id },
      data: { status: ModelStatus.Draft, availability: Availability.Public },
    });

    await dbWrite.modelVersion.updateMany({
      where: { modelId: id },
      data: {
        status: ModelStatus.Draft,
        publishedAt: null,
        // Revert availability too — the success path flips versions to Private
        // before the post creation step, so a failure there would otherwise
        // leave versions orphaned at Private with a Public parent model.
        availability: Availability.Public,
      },
    });

    throw throwDbError(error);
  }
};

export const publishPrivateModel = async ({
  modelId,
  publishVersions,
}: PublishPrivateModelInput) => {
  const model = await dbRead.model.findUnique({
    where: { id: modelId },
    select: { id: true, userId: true, availability: true, status: true, meta: true },
  });

  if (!model) throw throwNotFoundError('Model not found');

  const versions = await dbRead.modelVersion.findMany({
    where: { modelId, status: ModelStatus.Published },
    select: { id: true },
  });

  if (!versions.length) {
    throw throwBadRequestError('Model has no published versions');
  }

  const versionIds = versions.map((v) => v.id);
  const now = new Date();

  // Going public requires a showcase post on each version. A privately-published
  // trained LoRA can be postless (its auto-created post may have been emptied by
  // sample-image moderation, then deleted by clean-if-empty). Without this guard
  // it would go public with no post and the nightly requirements cron would
  // immediately re-unpublish it. Block instead, directing the user to add images.
  if (publishVersions) {
    // Read from primary: this gates the write transaction below, and a user who
    // just added the showcase post then immediately publishes could otherwise
    // hit replica lag → false "missing post" → incorrect hard block.
    const versionsWithPost = await dbWrite.post.findMany({
      where: { modelVersionId: { in: versionIds }, userId: model.userId },
      select: { modelVersionId: true },
      distinct: ['modelVersionId'],
    });
    const havePost = new Set(versionsWithPost.map((p) => p.modelVersionId));
    const missingPost = versionIds.filter((id) => !havePost.has(id));
    if (missingPost.length) {
      throw throwBadRequestError(
        'Add example images before making this model public. Each version must include a showcase post.'
      );
    }
  }

  await dbWrite.$transaction(async (tx) => {
    // Availability + demotion to null flip unconditionally; the publish
    // bump to `now` is routed through the anti-bump SQL guard below so an
    // already-public post (e.g. a Public→Private→Public flip) keeps its
    // original publishedAt. Same invariant as publishModelById:2154-2167.
    await tx.post.updateMany({
      where: {
        modelVersionId: { in: versionIds },
      },
      data: {
        publishedAt: publishVersions ? undefined : null,
        availability: Availability.Public,
      },
    });
    if (publishVersions) {
      // Write-once-on-republish: honor the prevPublishedAt stash if it
      // exists (e.g. post was previously public, unpublished via parent,
      // then the model went through a Private cycle). Strips the stash on
      // success. Mirrors the CASE pattern used by publishModelVersionById
      // and publishModelById.
      await tx.$executeRaw`
        UPDATE "Post"
        SET
          "publishedAt" = CASE
            WHEN "metadata"->>'prevPublishedAt' IS NOT NULL
            THEN ("metadata"->>'prevPublishedAt')::timestamptz
            ELSE ${now}
          END,
          "metadata" = "metadata" - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt'
        WHERE "modelVersionId" IN (${Prisma.join(versionIds, ',')})
        AND ("publishedAt" IS NULL OR "publishedAt" > NOW())
      `;
    }

    await tx.modelVersion.updateMany({
      where: { id: { in: versionIds } },
      data: {
        availability: Availability.Public,
        status: publishVersions ? ModelStatus.Published : ModelStatus.Draft,
        // Private->Public flip: status flips unconditionally; publishedAt is
        // handled separately under the anti-bump SQL guard below so legacy
        // rows with NULL publishedAt still get a first-publish timestamp,
        // while already-public rows keep their original date. Demotion
        // writes null so a follow-up publish can transition cleanly.
        publishedAt: publishVersions ? undefined : null,
      },
    });

    await tx.model.update({
      where: {
        id: modelId,
      },
      data: {
        availability: Availability.Public,
        status: publishVersions ? ModelStatus.Published : ModelStatus.Unpublished,
        // Same rationale as the ModelVersion write above.
        publishedAt: publishVersions ? undefined : null,
        meta: {
          ...((model.meta ?? {}) as ModelMeta),
          cannotPromote: false,
        },
      },
      select: { id: true },
    });

    if (publishVersions) {
      // Anti-bump guard: set publishedAt = NOW() only on rows that are
      // currently NULL (never published) or scheduled in the future. Rows
      // already public keep their original publishedAt — same invariant as
      // publishModelById / publishModelVersionById.
      await tx.$executeRaw`
        UPDATE "ModelVersion"
        SET "publishedAt" = ${now}
        WHERE id IN (${Prisma.join(versionIds, ',')})
        AND ("publishedAt" IS NULL OR "publishedAt" > NOW())
      `;
      await tx.$executeRaw`
        UPDATE "Model"
        SET "publishedAt" = ${now}
        WHERE id = ${modelId}
        AND ("publishedAt" IS NULL OR "publishedAt" > NOW())
      `;
    }
  });

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

export const setModelOfficial = async ({
  id,
  isOfficial,
  isModerator,
}: SetModelOfficialInput & {
  isModerator: boolean;
}) => {
  if (!isModerator) throw throwAuthorizationError();

  const model = await getModel({ id, select: { id: true } });
  if (!model) throw throwNotFoundError(`No model with id ${id}`);

  const updated = await dbWrite.model.update({
    where: { id },
    data: { isOfficial },
    select: { id: true, isOfficial: true },
  });

  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);
  await bustFetchThroughCache(REDIS_KEYS.CACHES.OFFICIAL_MODELS);

  return updated;
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
        cast(SUM(amount) as int) as earned
        FROM orchestration.resourceCompensations
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

export async function transferModelOwnership({
  modelIds,
  targetUserId,
  modUserId,
}: TransferModelOwnershipInput & { modUserId: number }) {
  const targetUser = await dbWrite.user.findFirst({
    where: { id: targetUserId, deletedAt: null },
    select: { id: true },
  });
  if (!targetUser) throw throwNotFoundError('Target user not found or deleted');

  const models = await dbWrite.model.findMany({
    where: { id: { in: modelIds } },
    select: { id: true, userId: true, nsfw: true },
  });
  if (models.length !== modelIds.length) {
    const found = new Set(models.map((m) => m.id));
    const missing = modelIds.filter((id) => !found.has(id));
    throw throwNotFoundError(`Models not found: ${missing.join(', ')}`);
  }

  const sourceUserIds = Array.from(new Set(models.map((m) => m.userId)));
  if (models.some((m) => m.userId === targetUserId))
    throw throwBadRequestError('One or more models already belong to the target user');

  const affectedPosts = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT p.id
    FROM "Post" p
    JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
    WHERE mv."modelId" = ANY(${modelIds}::int[])
    AND p."userId" = ANY(${sourceUserIds}::int[])
  `;
  const affectedPostIds = affectedPosts.map((p) => p.id);
  const affectedImages = affectedPostIds.length
    ? await dbWrite.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Image"
        WHERE "postId" = ANY(${affectedPostIds}::int[])
        AND "userId" = ANY(${sourceUserIds}::int[])
      `
    : [];
  const affectedImageIds = affectedImages.map((i) => i.id);

  const result = await dbWrite.$transaction([
    dbWrite.model.updateMany({
      where: { id: { in: modelIds } },
      data: { userId: targetUserId },
    }),
    // PaidAccess.ownerId is a denormalised copy of the model owner, and it is what decides who
    // generates free from a gated version and whose scheduled sales may reprice it. Left behind, the
    // previous owner keeps both over a model they no longer hold. Joined against ModelVersion rather
    // than a pre-read id list so a version created between the read and this statement is still moved.
    //
    // ModelVersionSale.userId deliberately does NOT move: a sale is the previous owner's pricing
    // decision. getSalesFor re-checks it against the owner resolved here, so their running sale stops
    // applying to a transferred version — the version reprices to full at the transfer, and that is the
    // intended outcome, not an oversight.
    dbWrite.$executeRaw`
      UPDATE "PaidAccess" pa
      SET "ownerId" = ${targetUserId}, "updatedAt" = NOW()
      FROM "ModelVersion" mv
      WHERE pa."entityType" = 'ModelVersion'::"PaidAccessEntityType"
        AND pa."entityId" = mv.id
        AND mv."modelId" = ANY(${modelIds}::int[])
        AND pa."ownerId" <> ${targetUserId}
    `,
    // DonationGoal.userId is the other owner copy the transfer used to miss, and this one routes
    // money: a donation pays goal.userId, so a donation on a transferred model paid the previous
    // owner. The target is dual-written (legacy modelVersionId + polymorphic entityType/entityId), so
    // both spellings have to move — as two statements, not one OR, because an OR across them makes the
    // planner drive from DonationGoal and seq-scan the whole table on every transfer regardless of how
    // many models it names (measured on prod: 176ms/155k buffers as an OR, ~20ms/3k buffers split).
    // The `userId <> target` guard also makes the two disjoint, so their counts sum without
    // double-counting a dual-written row — which holds only because these run in ONE transaction, in
    // THIS order, with that guard: leg 1 writes the target, so leg 2 no longer matches the row. Move
    // either statement out of the array or reorder them and the sum silently double-counts.
    dbWrite.$executeRaw`
      UPDATE "DonationGoal" dg
      SET "userId" = ${targetUserId}
      FROM "ModelVersion" mv
      WHERE mv."modelId" = ANY(${modelIds}::int[])
        AND dg."modelVersionId" = mv.id
        AND dg."userId" <> ${targetUserId}
    `,
    dbWrite.$executeRaw`
      UPDATE "DonationGoal" dg
      SET "userId" = ${targetUserId}
      FROM "ModelVersion" mv
      WHERE mv."modelId" = ANY(${modelIds}::int[])
        AND dg."entityType" = 'ModelVersion'::"PaidAccessEntityType"
        AND dg."entityId" = mv.id
        AND dg."userId" <> ${targetUserId}
    `,
    dbWrite.modelMetric.updateMany({
      where: { modelId: { in: modelIds } },
      data: { userId: targetUserId },
    }),
    dbWrite.$executeRaw`
      UPDATE "Post"
      SET "userId" = ${targetUserId}
      WHERE id = ANY(${affectedPostIds}::int[])
    `,
    dbWrite.$executeRaw`
      UPDATE "Image"
      SET "userId" = ${targetUserId}
      WHERE id = ANY(${affectedImageIds}::int[])
    `,
    // DELETED, not moved: ownerId records who spent an allowance, so moving it charges the recipient
    // for a pricing they never made. Leaving it is worse — the key is the entity alone, so the row is
    // both unreleasable (owner mismatch) and un-insertable, letting the recipient re-price that version
    // forever off the books. Every other stranded slot goes inert at the month turn; a transferred
    // entity outlives it.
    dbWrite.$executeRaw`
      DELETE FROM "PricingSlot" ps
      USING "ModelVersion" mv
      WHERE ps."entityType" = 'ModelVersion'::"PaidAccessEntityType"
        AND ps."entityId" = mv.id
        AND mv."modelId" = ANY(${modelIds}::int[])
    `,
  ]);

  const tracker = new Tracker();
  for (const m of models) {
    await tracker.modelEvent({ type: 'Transfer', modelId: m.id, nsfw: m.nsfw });
  }

  const affectedVersionIds = (
    await dbWrite.modelVersion.findMany({
      where: { modelId: { in: modelIds } },
      select: { id: true },
    })
  ).map((v) => v.id);

  // Fail-open, individually. These run AFTER the commit, so a throw here reports failure for a
  // transfer that already happened — and the retry is refused by the pre-flight guard above, leaving
  // the operator with no in-product way to finish the invalidation. A logged stale cache expires on
  // its own; nothing here can misroute money, because both payout paths read the primary fresh.
  const invalidation = (name: string, work: Promise<unknown>) =>
    work.catch((error) =>
      logToAxiom({
        type: 'error',
        name: 'model-ownership-transfer-invalidation',
        message: `${name} failed after a committed transfer`,
        error: { name, modelIds, targetUserId, error: String(error) },
      }).catch(() => null)
    );

  await Promise.all([
    // Everything keyed off the owner. modelVersionAccessCache is the one that matters most here: it
    // holds Model.userId for a DAY, and hasEntityAccess grants "owners always have access" from it, so
    // without this the previous owner keeps reaching a gated version the UPDATE above just moved.
    // Also queues the model search-index update these transferred models need.
    invalidation('bustMvCache', bustMvCache(affectedVersionIds, modelIds)),
    // Deliberately duplicated with the queueUpdate inside bustMvCache. That one sits behind four
    // awaits that can throw, and it is the only leg here whose loss is permanent — every cache
    // self-heals on a TTL, while the Meilisearch document keeps the previous owner until something
    // else touches the model. A duplicate enqueue is free: processQueues dedupes with a Set.
    invalidation(
      'modelsSearchIndex.queueUpdate',
      modelsSearchIndex.queueUpdate(
        modelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      )
    ),
    // The gate row carries ownerId and the public donation goal carries userId, so both have to go.
    // bustMvCache busts the gate row too as of 868kwp6ne — this stays as the deliberate duplicate that
    // keeps the pair together, and a second bust of an already-busted key costs one SET.
    invalidation('bustPaidAccessCache', bustPaidAccessCache('ModelVersion', affectedVersionIds)),
    invalidation(
      'bustPublicDonationGoals',
      modelVersionPublicDonationGoalsCache.bust(affectedVersionIds)
    ),
    affectedImageIds.length
      ? invalidation(
          'queueImageSearchIndexUpdate',
          queueImageSearchIndexUpdate({
            ids: affectedImageIds,
            action: SearchIndexUpdateQueueAction.Update,
          })
        )
      : Promise.resolve(),
  ]);

  await logToAxiom({
    type: 'info',
    name: 'model-ownership-transfer',
    message: 'Mod transferred model ownership',
    error: {
      modelIds,
      targetUserId,
      sourceUserIds,
      modUserId,
      modelsUpdated: result[0].count,
      paidAccessUpdated: Number(result[1]),
      donationGoalsUpdated: Number(result[2]) + Number(result[3]),
      metricsUpdated: result[4].count,
      postsUpdated: Number(result[5]),
      imagesUpdated: Number(result[6]),
    },
  }).catch(() => null);

  await Promise.all([...sourceUserIds, targetUserId].map((id) => deleteBasicDataForUser(id)));

  return {
    modelsUpdated: result[0].count,
    paidAccessUpdated: Number(result[1]),
    donationGoalsUpdated: Number(result[2]) + Number(result[3]),
    metricsUpdated: result[4].count,
    postsUpdated: Number(result[5]),
    imagesUpdated: Number(result[6]),
  };
}
