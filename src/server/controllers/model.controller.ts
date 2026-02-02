import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type { CommandResourcesAdd, ResourceType } from '~/components/CivitaiLink/shared-types';
import type { BaseModelType, ModelFileType } from '~/server/common/constants';
import {
  getBaseModelGenerationSupported,
  type BaseModel,
} from '~/shared/constants/base-model.constants';
import { constants } from '~/server/common/constants';
import {
  EntityAccessPermission,
  ModelSort,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import type { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import { dataForModelsCache, modelTagCache } from '~/server/redis/caches';
import { getInfiniteArticlesSchema } from '~/server/schema/article.schema';
import type { GetAllSchema, GetByIdInput, UserPreferencesInput } from '~/server/schema/base.schema';
import type {
  ModelVersionEarlyAccessConfig,
  ModelVersionMeta,
  RecommendedSettingsSchema,
  TrainingDetailsObj,
} from '~/server/schema/model-version.schema';
import type {
  ChangeModelModifierSchema,
  CopyGallerySettingsInput,
  DeclineReviewSchema,
  DeleteModelSchema,
  FindResourcesToAssociateSchema,
  GetAllModelsOutput,
  GetAssociatedResourcesInput,
  GetDownloadSchema,
  GetModelVersionsSchema,
  GetMyTrainingModelsSchema,
  GetSimpleModelsInfiniteSchema,
  LimitOnly,
  ModelByHashesInput,
  ModelGallerySettingsSchema,
  ModelMeta,
  ModelUpsertInput,
  PrivateModelFromTrainingInput,
  PublishModelSchema,
  PublishPrivateModelInput,
  ReorderModelVersionsSchema,
  SetModelCollectionShowcaseInput,
  ToggleCheckpointCoverageInput,
  ToggleModelLockInput,
  UnpublishModelSchema,
  UpdateGallerySettingsInput,
  GetModelByIdSchema,
} from '~/server/schema/model.schema';
import { getAllModelsSchema } from '~/server/schema/model.schema';
import { modelsSearchIndex } from '~/server/search-index';
import {
  associatedResourceSelect,
  getAllModelsWithVersionsSelect,
  modelWithDetailsSelect,
} from '~/server/selectors/model.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getArticles } from '~/server/services/article.service';
import { getCollectionById, getCollectionItemCount } from '~/server/services/collection.service';
import { hasEntityAccess } from '~/server/services/common.service';
import { getDownloadFilename, getFilesByEntity } from '~/server/services/file.service';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { bustMvCache } from '~/server/services/model-version.service';
import {
  copyGallerySettingsToAllModelsByUser,
  deleteModelById,
  getDraftModelsByUserId,
  getGallerySettingsByModelId,
  getModel,
  getModels,
  getModelsRaw,
  getModelsWithImagesAndModelVersions,
  getModelVersionsMicro,
  getPrivateModelCount,
  getTrainingModelsByUserId,
  getVaeFiles,
  permaDeleteModelById,
  privateModelFromTraining,
  publishModelById,
  publishPrivateModel,
  restoreModelById,
  setModelShowcaseCollection,
  toggleCheckpointCoverage,
  toggleLockModel,
  unpublishModelById,
  updateModelById,
  updateModelEarlyAccessDeadline,
  upsertModel,
} from '~/server/services/model.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { getHighestTierSubscription } from '~/server/services/subscriptions.service';
import { getCategoryTags } from '~/server/services/system-cache';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import {
  amIBlockedByUser,
  bustUserDownloadsCache,
  getUserSettings,
} from '~/server/services/user.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { filterSensitiveProfanityData } from '~/libs/profanity-simple/helpers';
import {
  allBrowsingLevelsFlag,
  getIsSafeBrowsingLevel,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  Availability,
  BountyType,
  CollectionItemStatus,
  MetricTimeframe,
  ModelHashType,
  ModelModifier,
  ModelStatus,
  ModelType,
  ModelUploadType,
  ModelUsageControl,
} from '~/shared/utils/prisma/enums';
import { getDownloadUrl } from '~/utils/delivery-worker';
import { removeNulls } from '~/utils/object-helpers';
import { isDefined } from '~/utils/type-guards';
import { redis, REDIS_KEYS } from '../redis/client';
import type { BountyDetailsSchema } from '../schema/bounty.schema';
import {
  getResourceData,
  getUnavailableResources,
} from '../services/generation/generation.service';

// TODO.Briant - determine all the logic to check when getting model versions
/*
  1. If the model version status is not published, only return the version if the user is an owner or moderator
  2. Check if the user is blocked from using a model version (this should probably be done during page load)
  3. Don't fetch posts each time you get the model versions, only need to check for posts when a model is not published
  4  don't check for entity access on each version. Doesn't need to happen for versions that are already available
  5. ensure that we aren't fetching vae files when `!vadIds.length`
  6. get suggested resources in another api call
  7. getUnavailableResources needs to go. We can't have another source of truth for generation coverage
*/
export type GetModelReturnType = AsyncReturnType<typeof getModelHandler>;
export const getModelHandler = async ({
  input: { excludeTrainingData, ...input },
  ctx,
}: {
  input: GetModelByIdSchema;
  ctx: Context;
}) => {
  try {
    const model = await getModel({
      ...input,
      user: ctx.user,
      select: modelWithDetailsSelect,
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    if (ctx.user && !ctx.user.isModerator) {
      const blocked = await amIBlockedByUser({ userId: ctx.user.id, targetUserId: model.user.id });
      if (blocked) throw throwNotFoundError();
    }

    const features = ctx.features;
    const isOwner = ctx.user?.id === model.user.id || ctx.user?.isModerator;
    const filteredVersions = isOwner
      ? model.modelVersions
      : model.modelVersions.filter((version) => version.status === ModelStatus.Published);
    const modelVersionIds = filteredVersions.map((version) => version.id);
    const posts = await dbRead.post.findMany({
      where: {
        modelVersionId: { in: modelVersionIds },
        userId: model.user.id,
      },
      select: { id: true, modelVersionId: true },
      orderBy: { id: 'asc' },
    });
    const tagsOnModels = await modelTagCache.fetch(model.id);

    // recommended VAEs
    const vaeIds = filteredVersions.map((x) => x.vaeId).filter(isDefined);
    const vaeFiles = await getVaeFiles({ vaeIds });

    const suggestedResources = await dbRead.modelAssociations.count({
      where: { fromModelId: model.id, type: 'Suggested' },
    });

    const modelCategories = await getCategoryTags('model');
    const unavailableGenResources = await getUnavailableResources();

    const metrics = model.metrics[0];
    const canManage = ctx.user?.id === model.user.id || ctx.user?.isModerator;
    const entityAccess = await hasEntityAccess({
      entityIds: filteredVersions.map((x) => x.id),
      entityType: 'ModelVersion',
      isModerator: ctx.user?.isModerator,
      userId: ctx.user?.id,
    });

    const recommendedResourceIds =
      model.modelVersions.flatMap((version) => version?.recommendedResources.map((x) => x.id)) ??
      [];
    const generationResources = await getResourceData(recommendedResourceIds, ctx?.user);

    return {
      ...model,
      metrics: undefined,
      rank: {
        downloadCountAllTime: metrics?.downloadCount ?? 0,
        thumbsUpCountAllTime: metrics?.thumbsUpCount ?? 0,
        thumbsDownCountAllTime: metrics?.thumbsDownCount ?? 0,
        commentCountAllTime: metrics?.commentCount ?? 0,
        tippedAmountCountAllTime: metrics?.tippedAmountCount ?? 0,
        imageCountAllTime: metrics?.imageCount ?? 0,
        collectedCountAllTime: metrics?.collectedCount ?? 0,
        generationCountAllTime: metrics?.generationCount ?? 0,
      },
      canGenerate: filteredVersions.some(
        (version) =>
          !!version.generationCoverage?.covered &&
          unavailableGenResources.indexOf(version.id) === -1 &&
          getBaseModelGenerationSupported(version.baseModel, model.type)
      ),
      hasSuggestedResources: suggestedResources > 0,
      meta: model.meta
        ? filterSensitiveProfanityData(model.meta as ModelMeta, ctx?.user?.isModerator)
        : null,
      tagsOnModels:
        tagsOnModels[model.id]?.tags
          .filter(({ unlisted }) => !unlisted)
          .map(({ id, name }) => ({
            tag: {
              id,
              name: name!,
              isCategory: modelCategories.some((c) => c.id === id),
            },
          })) ?? [],
      modelVersions: filteredVersions.map((version) => {
        let earlyAccessDeadline = features.earlyAccessModel ? version.earlyAccessEndsAt : undefined;
        if (earlyAccessDeadline && new Date() > earlyAccessDeadline)
          earlyAccessDeadline = undefined;

        const entityAccessForVersion = entityAccess.find((x) => x.entityId === version.id);
        const isDownloadable = version.usageControl === ModelUsageControl.Download || isOwner;
        const canDownload =
          isDownloadable &&
          model.mode !== ModelModifier.Archived &&
          entityAccessForVersion?.hasAccess &&
          (!earlyAccessDeadline ||
            (entityAccessForVersion?.permissions ?? 0) >=
              EntityAccessPermission.EarlyAccessDownload);

        const canGenerate =
          !!version.generationCoverage?.covered &&
          unavailableGenResources.indexOf(version.id) === -1 &&
          getBaseModelGenerationSupported(version.baseModel, model.type);

        // sort version files by file type, 'Model' type goes first
        const vaeFile = vaeFiles.filter((x) => x.modelVersionId === version.vaeId);
        version.files.push(...vaeFile);
        const files = isDownloadable
          ? version.files
              .filter((x) => x.visibility === 'Public' || canManage)
              .sort((a, b) => {
                const aType = a.type as ModelFileType;
                const bType = b.type as ModelFileType;

                if (constants.modelFileOrder[aType] < constants.modelFileOrder[bType]) return -1;
                else if (constants.modelFileOrder[aType] > constants.modelFileOrder[bType])
                  return 1;
                else return 0;
              })
          : [];

        if (excludeTrainingData) {
          for (const file of files) {
            if (file.metadata && typeof file.metadata === 'object') {
              delete (file.metadata as Record<string, any>).trainingResults;
              delete (file.metadata as Record<string, any>).selectedEpochUrl;
            }
          }
        }

        const hashes = version.files
          .filter((file) =>
            (['Model', 'Pruned Model'] as ModelFileType[]).includes(file.type as ModelFileType)
          )
          .map((file) =>
            file.hashes.find((x) => x.type === ModelHashType.SHA256)?.hash.toLowerCase()
          )
          .filter(isDefined);

        const versionMetrics = version.metrics[0];

        return {
          ...version,
          metrics: undefined,
          rank: {
            generationCountAllTime: versionMetrics?.generationCount ?? 0,
            downloadCountAllTime: versionMetrics?.downloadCount ?? 0,
            thumbsUpCountAllTime: versionMetrics?.thumbsUpCount ?? 0,
            thumbsDownCountAllTime: versionMetrics?.thumbsDownCount ?? 0,
            earnedAmountAllTime: versionMetrics?.earnedAmount ?? 0,
          },
          posts: posts.filter((x) => x.modelVersionId === version.id).map((x) => ({ id: x.id })),
          hashes,
          earlyAccessDeadline,
          earlyAccessConfig: version.earlyAccessConfig as ModelVersionEarlyAccessConfig | null,
          canDownload,
          canGenerate,
          files: files as Array<
            Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }
          >,
          baseModel: version.baseModel as BaseModel,
          baseModelType: version.baseModelType as BaseModelType,
          meta: version.meta
            ? filterSensitiveProfanityData(version.meta as ModelVersionMeta, ctx?.user?.isModerator)
            : null,
          trainingDetails: version.trainingDetails as TrainingDetailsObj | undefined,
          settings: version.settings as RecommendedSettingsSchema | undefined,
          recommendedResources: version.recommendedResources
            .map((item) => {
              const match = generationResources.find((x) => x.id === item.resource.id);
              if (!match) return null;
              return { ...match, ...removeNulls(item.settings as RecommendedSettingsSchema) };
            })
            .filter(isDefined),
        };
      }),
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export type GetModelsInfiniteReturnType = AsyncReturnType<typeof getModelsInfiniteHandler>['items'];

export const getModelsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: GetAllModelsOutput;
  ctx: Context;
}) => {
  try {
    let loopCount = 0;
    let isPrivate = false;
    let nextCursor: string | bigint | undefined;
    const results: Awaited<ReturnType<typeof getModelsWithImagesAndModelVersions>>['items'] = [];
    while (results.length < (input.limit ?? 100) && loopCount < 3) {
      const result = await getModelsWithImagesAndModelVersions({
        input,
        user: ctx.user,
      });
      if (result.isPrivate) isPrivate = true;
      results.push(...result.items);
      if (!result.nextCursor) break;

      input.cursor = result.nextCursor;
      nextCursor = result.nextCursor;
      loopCount++;
    }
    if (isPrivate) ctx.cache.canCache = false;
    return { items: results, nextCursor };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const getModelsPagedSimpleHandler = async ({
  input,
  ctx,
}: {
  input: GetAllModelsOutput;
  ctx: Context;
}) => {
  const { limit = DEFAULT_PAGE_SIZE, page, cursor, ...restInput } = input || {};
  const { take, skip } = getPagination(limit, page);
  const results = await getModels({
    input: { ...restInput, take, skip },
    user: ctx.user,
    select: {
      id: true,
      name: true,
      nsfw: true,
      meta: true,
      modelVersions: input.needsReview
        ? {
            select: { id: true, name: true, meta: true },
            where: { meta: { path: ['needsReview'], equals: true } },
            take: 1,
          }
        : false,
    },
  });

  const isModerator = ctx?.user?.isModerator;
  const parsedResults = {
    ...results,
    items: results.items.map(({ modelVersions = [], ...model }) => {
      const [version] = modelVersions;

      return {
        ...model,
        meta: model.meta
          ? filterSensitiveProfanityData(model.meta as ModelMeta, isModerator)
          : null,
        modelVersion: version
          ? {
              ...version,
              meta: version.meta
                ? filterSensitiveProfanityData(version.meta as ModelVersionMeta, isModerator)
                : null,
            }
          : undefined,
      };
    }),
  };
  return getPagingData(parsedResults, take, page);
};

export const getModelVersionsHandler = async ({ input }: { input: GetModelVersionsSchema }) => {
  try {
    const modelVersions = await getModelVersionsMicro(input);
    return modelVersions;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertModelHandler = async ({
  input,
  ctx,
}: {
  input: ModelUpsertInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const { nsfw, poi, minor, sfwOnly, availability } = input;

    if (nsfw && poi)
      throw throwBadRequestError('Mature content depicting actual people is not permitted.');

    if (nsfw && minor)
      throw throwBadRequestError('Mature content depicting minors is not permitted.');

    if (nsfw && sfwOnly)
      throw throwBadRequestError('Mature content on a model marked as SFW is not permitted.');

    if (availability === Availability.Private && !sfwOnly)
      throw throwBadRequestError('Private models must be set to SFW only.');

    // Check tags for multiple categories
    const { tagsOnModels } = input;
    if (tagsOnModels?.length) {
      const modelCategories = await getCategoryTags('model');
      const matchedTags = tagsOnModels.filter((tag) =>
        modelCategories.some((categoryTag) => categoryTag.name === tag.name)
      );

      if (matchedTags.length > 1)
        throw throwBadRequestError(
          `Model cannot have multiple categories. Please include only one from: ${matchedTags
            .map((tag) => tag.name)
            .join(', ')}`
        );
    }

    const { gallerySettings } = await getUserSettings(userId);
    const model = await upsertModel({
      ...input,
      userId,
      isModerator: ctx.user.isModerator,
      gallerySettings: {
        ...gallerySettings,
        level: input.minor || input.sfwOnly ? sfwBrowsingLevelsFlag : gallerySettings?.level,
      },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id as number}`);

    await ctx.track.modelEvent({
      type: input.id ? 'Update' : 'Create',
      modelId: model.id,
      nsfw: !getIsSafeBrowsingLevel(model.nsfwLevel),
    });

    if (input.id) await dataForModelsCache.bust(input.id);

    return model;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const publishModelHandler = async ({
  input,
  ctx,
}: {
  input: PublishModelSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const model = await dbRead.model.findUnique({
      where: { id: input.id },
      select: { status: true, meta: true, nsfw: true },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);
    if (model.status === ModelStatus.Published)
      throw throwBadRequestError('Model is already published');

    const { isModerator } = ctx.user;
    if (!isModerator && constants.modPublishOnlyStatuses.includes(model.status))
      throw throwAuthorizationError('You are not authorized to publish this model');

    const modelMeta = model.meta as ModelMeta | null;
    const republishing =
      model.status !== ModelStatus.Draft && model.status !== ModelStatus.Scheduled;
    const { needsReview, unpublishedReason, unpublishedAt, customMessage, ...meta } =
      modelMeta || {};
    const updatedModel = await publishModelById({ ...input, meta, republishing });

    await updateModelEarlyAccessDeadline({ id: updatedModel.id }).catch((e) => {
      console.error('Unable to update model early access deadline');
      console.error(e);
    });

    // Track event in the background
    ctx.track
      .modelEvent({
        type: 'Publish',
        modelId: input.id,
        nsfw: model.nsfw,
      })
      .catch(handleLogError);

    if (!input.publishedAt || input.publishedAt <= new Date()) {
      await eventEngine.processEngagement({
        userId: updatedModel.userId,
        type: 'published',
        entityType: 'model',
        entityId: updatedModel.id,
      });
    }

    await dataForModelsCache.bust(input.id);

    return updatedModel;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export const unpublishModelHandler = async ({
  input,
  ctx,
}: {
  input: UnpublishModelSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id } = input;
    const model = await dbRead.model.findUnique({
      where: { id },
      select: { meta: true, nsfw: true },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    const meta = (model.meta as ModelMeta | null) || {};
    const updatedModel = await unpublishModelById({
      ...input,
      meta,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });

    await ctx.track.modelEvent({
      type: 'Unpublish',
      modelId: id,
      nsfw: model.nsfw,
    });

    await dataForModelsCache.bust(input.id);

    return updatedModel;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export const deleteModelHandler = async ({
  input,
  ctx,
}: {
  input: DeleteModelSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id, permanently } = input;
    if (permanently && !ctx.user.isModerator) throw throwAuthorizationError();

    const deleteModel = permanently ? permaDeleteModelById : deleteModelById;
    const model = await deleteModel({ id, userId: ctx.user.id, isModerator: ctx.user.isModerator });
    if (!model) throw throwNotFoundError(`No model with id ${id}`);

    await ctx.track.modelEvent({
      type: permanently ? 'PermanentDelete' : 'Delete',
      modelId: model.id,
      nsfw: !getIsSafeBrowsingLevel(model.nsfwLevel),
    });

    await dataForModelsCache.bust(id);

    return model;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

/** WEBHOOKS CONTROLLERS */
export const getModelsWithVersionsHandler = async ({
  input,
  ctx,
}: {
  input: GetAllModelsOutput & { ids?: number[] };
  ctx: Context;
}) => {
  const { limit = DEFAULT_PAGE_SIZE, page, cursor, ...queryInput } = input;
  const { take, skip } = getPagination(limit, page);
  try {
    // TODO.manuel: Make this use the getModelsRaw instead...
    const rawResults = await getModels({
      input: { ...queryInput, take, skip },
      user: ctx.user,
      select: getAllModelsWithVersionsSelect,
      count: true,
    });

    const modelVersionIds = rawResults.items.flatMap(({ modelVersions }) =>
      modelVersions.map(({ id }) => id)
    );
    const images = await getImagesForModelVersion({
      modelVersionIds,
      imagesPerVersion: 10,
      include: [],
      excludedTagIds: input.excludedTagIds,
      excludedIds: input.excludedImageIds,
      excludedUserIds: input.excludedUserIds,
      user: ctx.user,
      browsingLevel: input.browsingLevel,
      pending: input.pending,
    });
    const modelIds = rawResults.items.map(({ id }) => id);
    const tagsOnModels = await modelTagCache.fetch(modelIds);

    const vaeIds = rawResults.items
      .flatMap(({ modelVersions }) => modelVersions.map(({ vaeId }) => vaeId))
      .filter(isDefined);
    const vaeFiles = await getVaeFiles({ vaeIds });

    const metrics = await dbRead.modelMetric.findMany({
      where: { modelId: { in: modelIds } },
    });

    function getStatsForModel(modelId: number) {
      const stats = metrics.find((x) => x.modelId === modelId);
      return {
        downloadCount: stats?.downloadCount ?? 0,
        thumbsUpCount: stats?.thumbsUpCount ?? 0,
        thumbsDownCount: stats?.thumbsDownCount ?? 0,
        commentCount: stats?.commentCount ?? 0,
        tippedAmountCount: stats?.tippedAmountCount ?? 0,
      };
    }

    const results = {
      count: rawResults.count,
      items: rawResults.items.map(({ modelVersions, ...model }) => ({
        ...model,
        tags: tagsOnModels[model.id]?.tags.map((x) => x.name) ?? [],
        modelVersions: modelVersions.map(({ metrics, files, ...modelVersion }) => {
          const vaeFile = vaeFiles.filter((x) => x.modelVersionId === modelVersion.vaeId);
          files.push(...vaeFile);
          return {
            ...modelVersion,
            files,
            stats: {
              downloadCount: metrics[0]?.downloadCount ?? 0,
              thumbsUpCount: metrics[0]?.thumbsUpCount ?? 0,
              thumbsDownCount: metrics[0]?.thumbsDownCount ?? 0,
            },
            images: images
              .filter((image) => image.modelVersionId === modelVersion.id)
              .map(({ modelVersionId, name, userId, ...image }) => ({
                ...image,
              })),
          };
        }),
        stats: getStatsForModel(model.id),
      })),
    };

    return getPagingData(results, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getModelWithVersionsHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  const results = await getModelsWithVersionsHandler({
    input: {
      ids: [input.id],
      sort: ModelSort.HighestRated,
      favorites: false,
      hidden: false,
      period: 'AllTime',
      periodMode: 'published',
      browsingLevel: allBrowsingLevelsFlag,
    },
    ctx,
  });
  if (!results.items.length) throw throwNotFoundError(`No model with id ${input.id}`);

  return results.items[0];
};

// TODO - TEMP HACK for reporting modal
export const getModelReportDetailsHandler = async ({ input: { id } }: { input: GetByIdInput }) => {
  try {
    return await dbRead.model.findUnique({
      where: { id },
      select: { userId: true, reportStats: { select: { ownershipPending: true } } },
    });
  } catch (error) {}
};

const additionalFiles: { [k in ModelFileType]?: ResourceType } = {
  Config: 'CheckpointConfig',
  VAE: 'VAE',
  Negative: 'TextualInversion',
};
export const getDownloadCommandHandler = async ({
  input: { modelId, modelVersionId, type, format },
  ctx,
}: {
  input: GetDownloadSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const fileWhere: Prisma.ModelFileWhereInput = {};
    if (type) fileWhere.type = type;
    if (format) fileWhere.metadata = { path: ['format'], equals: format };

    const modelVersion = await dbRead.modelVersion.findFirst({
      where: { modelId, id: modelVersionId },
      select: {
        id: true,
        model: {
          select: {
            id: true,
            name: true,
            type: true,
            status: true,
            userId: true,
            mode: true,
            nsfw: true,
          },
        },
        usageControl: true,
        // images: {
        //   select: {
        //     image: { select: { url: true } },
        //   },
        //   orderBy: prioritizeSafeImages
        //     ? [{ image: { nsfw: 'asc' } }, { index: 'asc' }]
        //     : [{ index: 'asc' }],
        //   take: 1,
        // },
        name: true,
        trainedWords: true,
        createdAt: true,
        files: {
          where: fileWhere,
          select: {
            url: true,
            name: true,
            type: true,
            metadata: true,
            hashes: { select: { hash: true }, where: { type: 'SHA256' } },
          },
        },
      },
      orderBy: { index: 'asc' },
    });
    if (!modelVersion) throw throwNotFoundError();

    const isOwner = ctx.user?.id === modelVersion.model.userId;
    const isDownloadable =
      modelVersion.usageControl === ModelUsageControl.Download || isOwner || ctx.user?.isModerator;

    if (!isDownloadable) {
      throw throwAuthorizationError();
    }

    const [access] = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [modelVersion.id],
      userId: ctx.user.id,
    });
    if (
      !access ||
      !access.hasAccess ||
      (access.permissions & EntityAccessPermission.EarlyAccessDownload) === 0
    ) {
      throw throwAuthorizationError();
    }

    const { model, files } = modelVersion;
    const castedFiles = files as Array<
      Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }
    >;

    const file =
      type != null || format != null
        ? castedFiles[0]
        : getPrimaryFile(castedFiles, {
            metadata: ctx.user?.filePreferences,
          });
    if (!file) throw throwNotFoundError();

    const isMod = ctx.user?.isModerator;
    const userId = ctx.user?.id;
    const canDownload =
      modelVersion.model.mode !== ModelModifier.Archived &&
      (isMod ||
        modelVersion?.model?.status === 'Published' ||
        modelVersion.model.userId === userId);

    if (!canDownload) throw throwNotFoundError();

    const now = new Date();

    if (isDownloadable) {
      // Best not to track for versions that are not downloadable.
      // Safer for us.
      ctx.track.modelVersionEvent({
        type: 'Download',
        modelId: modelVersion.model.id,
        modelVersionId: modelVersion.id,
        nsfw: modelVersion.model.nsfw,
        time: now,
      });

      // Bust the downloads cache so the user sees their download immediately
      if (ctx.user?.id) {
        bustUserDownloadsCache(ctx.user.id).catch(() => {
          // ignore
        });
      }
    }

    const fileName = getDownloadFilename({ model, modelVersion, file });
    const { url } = await getDownloadUrl(file.url, fileName);

    const commands: CommandResourcesAdd[] = [];
    commands.push({
      type: 'resources:add',
      resource: {
        type: model.type,
        hash: file.hashes[0].hash,
        name: fileName,
        modelName: model.name,
        modelVersionName: modelVersion.name,
        // previewImage: modelVersion.images[0]?.image?.url,
        url,
      },
    });

    // Add additional files
    for (const [type, resourceType] of Object.entries(additionalFiles)) {
      const additionalFile = files.find((f) => f.type === type);
      if (!additionalFile) continue;

      const additionalFileName = getDownloadFilename({ model, modelVersion, file: additionalFile });
      commands.push({
        type: 'resources:add',
        resource: {
          type: resourceType,
          hash: additionalFile.hashes[0].hash,
          name: additionalFileName,
          modelName: model.name,
          modelVersionName: modelVersion.name,
          url: (await getDownloadUrl(additionalFile.url, additionalFileName)).url,
        },
      });
    }

    return { commands };
  } catch (error) {
    throwDbError(error);
  }
};

export const getModelDetailsForReviewHandler = async ({
  input: { id },
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const model = getModel({
      id,
      user: ctx.user,
      select: {
        poi: true,
        modelVersions: {
          select: { id: true, name: true },
        },
      },
    });
    if (!model) throw throwNotFoundError();
    return model;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const restoreModelHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  if (!ctx.user.isModerator) throw throwAuthorizationError();

  try {
    const model = await restoreModelById({ ...input });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    await modelsSearchIndex.queueUpdate([
      { id: input.id, action: SearchIndexUpdateQueueAction.Update },
    ]);

    await dataForModelsCache.bust(input.id);

    return model;
  } catch (error) {
    if (error instanceof TRPCError) error;
    else throw throwDbError(error);
  }
};

export const getMyDraftModelsHandler = async ({
  input,
  ctx,
}: {
  input: GetAllSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const results = await getDraftModelsByUserId({
      ...input,
      userId,
      select: {
        id: true,
        name: true,
        type: true,
        createdAt: true,
        status: true,
        updatedAt: true,
        modelVersions: {
          select: {
            _count: {
              select: { files: true, posts: { where: { userId, publishedAt: { not: null } } } },
            },
          },
        },
        _count: { select: { modelVersions: true } },
      },
    });

    return results;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getMyTrainingModelsHandler = async ({
  input,
  ctx,
}: {
  input: GetMyTrainingModelsSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    return await getTrainingModelsByUserId({
      ...input,
      userId,
      select: {
        id: true,
        trainingDetails: true,
        trainingStatus: true,
        trainedWords: true,
        name: true,
        createdAt: true,
        updatedAt: true,

        model: {
          select: {
            id: true,
            name: true,
            status: true,
            _count: {
              select: {
                modelVersions: true,
              },
            },
          },
        },

        files: {
          select: {
            id: true,
            url: true,
            type: true,
            metadata: true,
            sizeKB: true,
            dataPurged: true,
          },
          where: { type: { equals: 'Training Data' } },
        },
      },
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getAvailableTrainingModelsHandler = async ({
  input: { take },
  ctx,
}: {
  input: LimitOnly;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await dbRead.model.findMany({
      where: {
        userId: ctx.user.id,
        uploadType: ModelUploadType.Trained,
        status: { notIn: [ModelStatus.Deleted] },
      },
      select: {
        id: true,
        name: true,
        modelVersions: {
          select: {
            id: true,
            trainingDetails: true,
            baseModel: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const reorderModelVersionsHandler = async ({
  input,
}: {
  input: ReorderModelVersionsSchema;
}) => {
  try {
    const model = await updateModelById({
      id: input.id,
      data: {
        modelVersions: {
          update: input.modelVersions.map((modelVersion, index) => ({
            where: { id: modelVersion.id },
            data: { index },
          })),
        },
      },
    });

    await modelsSearchIndex.queueUpdate([
      { id: input.id, action: SearchIndexUpdateQueueAction.Update },
    ]);

    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    await dataForModelsCache.bust(input.id);

    return model;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const toggleModelLockHandler = async ({ input }: { input: ToggleModelLockInput }) => {
  try {
    await toggleLockModel(input);
  } catch (error) {
    if (error instanceof TRPCError) error;
    else throw throwDbError(error);
  }
};

export const requestReviewHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const model = await dbRead.model.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        name: true,
        status: true,
        type: true,
        uploadType: true,
        meta: true,
        userId: true,
      },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);
    if (model.status !== ModelStatus.UnpublishedViolation)
      throw throwBadRequestError(
        'Cannot request a review for this model because it is not in the correct status'
      );

    const meta = (model.meta as ModelMeta | null) || {};
    const updatedModel = await upsertModel({
      ...model,
      meta: { ...meta, needsReview: true },
    });

    return updatedModel;
  } catch (error) {
    if (error instanceof TRPCError) error;
    else throw throwDbError(error);
  }
};

export const declineReviewHandler = async ({
  input,
  ctx,
}: {
  input: DeclineReviewSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    if (!ctx.user.isModerator) throw throwAuthorizationError();

    const model = await dbRead.model.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        name: true,
        status: true,
        type: true,
        uploadType: true,
        meta: true,
        userId: true,
      },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    const meta = (model.meta as ModelMeta | null) || {};
    if (model.status !== ModelStatus.UnpublishedViolation && !meta?.needsReview)
      throw throwBadRequestError(
        'Cannot decline a review for this model because it is not in the correct status'
      );

    const updatedModel = await upsertModel({
      ...model,
      meta: {
        ...meta,
        declinedReason: input.reason,
        declinedAt: new Date().toISOString(),
        needsReview: false,
      },
    });
    await trackModActivity(ctx.user.id, {
      entityType: 'model',
      entityId: model.id,
      activity: 'review',
    });

    return updatedModel;
  } catch (error) {
    if (error instanceof TRPCError) error;
    else throw throwDbError(error);
  }
};

export const changeModelModifierHandler = async ({
  input,
  ctx,
}: {
  input: ChangeModelModifierSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id, mode } = input;
    // If changing to takenDown, only moderators can do it
    if (mode === ModelModifier.TakenDown && !ctx.user.isModerator) throw throwAuthorizationError();

    const model = await getModel({ id, select: { id: true, meta: true, mode: true } });
    if (!model) throw throwNotFoundError(`No model with id ${id}`);
    if (model.mode === mode) throw throwBadRequestError(`Model is already ${String(mode)}`);
    // If removing mode, but model is taken down, only moderators can do it
    if (model.mode === ModelModifier.TakenDown && mode === null && !ctx.user.isModerator)
      throw throwAuthorizationError();

    const { archivedAt, takenDownAt, archivedBy, takenDownBy, ...restMeta } =
      (model.meta as ModelMeta | null) || {};
    let updatedMeta: ModelMeta = {};
    if (mode === ModelModifier.Archived)
      updatedMeta = { ...restMeta, archivedAt: new Date().toISOString(), archivedBy: ctx.user.id };
    else if (mode === ModelModifier.TakenDown)
      updatedMeta = {
        ...restMeta,
        takenDownAt: new Date().toISOString(),
        takenDownBy: ctx.user.id,
      };
    else updatedMeta = restMeta;

    const updatedModel = await updateModelById({
      id,
      data: { mode, meta: { ...updatedMeta } },
    });

    if (mode === ModelModifier.Archived || mode === ModelModifier.TakenDown) {
      await ctx.track.modelEvent({
        type: mode === ModelModifier.Archived ? 'Archive' : 'Takedown',
        modelId: updatedModel.id,
        nsfw: true,
      });
    }

    return updatedModel;
  } catch (error) {
    if (error instanceof TRPCError) error;
    else throw throwDbError(error);
  }
};

// #region [associated models]
export const findResourcesToAssociateHandler = async ({
  input,
}: {
  input: FindResourcesToAssociateSchema;
  ctx: Context;
}) => {
  try {
    const { cursor, ...modelInput } = getAllModelsSchema.parse(input);
    const articleInput = getInfiniteArticlesSchema.parse(input);

    const [{ items: models }, { items: articles }] = await Promise.all([
      getModels({
        input: { ...modelInput, take: modelInput.limit },
        select: associatedResourceSelect,
      }),
      getArticles({ ...articleInput }),
    ]);

    return { models, articles };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

// Used to get the associated resources for a model
type AssociatedResourceData = AsyncReturnType<typeof getAssociatedResourcesCardDataHandler>;
type AssociatedResourceCardData = AssociatedResourceData[number];
export type AssociatedResourceModelCardData = Extract<
  AssociatedResourceCardData,
  { resourceType: 'model' }
>;
export type AssociatedResourceArticleCardData = Extract<
  AssociatedResourceCardData,
  { resourceType: 'article' }
>;
export const getAssociatedResourcesCardDataHandler = async ({
  input,
  ctx,
}: {
  input: GetAssociatedResourcesInput & UserPreferencesInput;
  ctx: Context;
}) => {
  try {
    const { fromId, type, ...userPreferences } = input;
    const { user } = ctx;
    const associatedResources = await dbRead.modelAssociations.findMany({
      where: { fromModelId: fromId, type },
      select: { toModelId: true, toArticleId: true },
      orderBy: { index: 'asc' },
    });

    const resourcesIds = associatedResources.map(({ toModelId, toArticleId }) =>
      toModelId
        ? { id: toModelId, resourceType: 'model' as const }
        : { id: toArticleId, resourceType: 'article' as const }
    );

    if (!resourcesIds.length) return [];

    const modelResources = resourcesIds
      .filter(({ resourceType }) => resourceType === 'model')
      .map(({ id }) => id);
    const articleResources = resourcesIds
      .filter(({ resourceType }) => resourceType === 'article')
      .map(({ id }) => id);

    const period = MetricTimeframe.AllTime;
    const { cursor, ...modelInput } = getAllModelsSchema.parse({
      ...userPreferences,
      ids: modelResources,
      period,
    });
    const articleInput = getInfiniteArticlesSchema.parse({
      ...userPreferences,
      ids: articleResources,
      period,
    });

    const { items: models } =
      modelResources?.length > 0
        ? await getModelsRaw({
            user,
            input: modelInput,
          })
        : { items: [] };

    const { items: articles } =
      articleResources?.length > 0
        ? await getArticles({ ...articleInput, sessionUser: user })
        : { items: [] };

    const modelVersionIds = models.flatMap((m) => m.modelVersions).map((m) => m.id);
    const images = !!modelVersionIds.length
      ? await getImagesForModelVersion({
          modelVersionIds,
          excludedTagIds: modelInput.excludedTagIds,
          excludedIds: input.excludedImageIds,
          excludedUserIds: modelInput.excludedUserIds,
          user,
          pending: modelInput.pending,
          browsingLevel: modelInput.browsingLevel,
        })
      : [];

    const unavailableGenResources = await getUnavailableResources();
    const completeModels = models
      .map(({ hashes, modelVersions, rank, tagsOnModels, ...model }) => {
        const [version] = modelVersions;
        if (!version) return null;
        const versionImages = images.filter((i) => i.modelVersionId === version.id);
        const showImageless =
          (user?.isModerator || model.user.id === user?.id) &&
          (modelInput.user || modelInput.username);
        if (!versionImages.length && !showImageless) return null;
        const canGenerate =
          !!version.covered &&
          !unavailableGenResources.includes(version.id) &&
          getBaseModelGenerationSupported(version.baseModel, model.type);

        return {
          ...model,
          tags: tagsOnModels.map(({ tagId }) => tagId),
          hashes: hashes.map((h) => h.toLowerCase()),
          rank: {
            downloadCount: rank?.downloadCountAllTime ?? 0,
            thumbsUpCount: rank?.thumbsUpCountAllTime ?? 0,
            thumbsDownCount: rank?.thumbsDownCountAllTime ?? 0,
            commentCount: rank?.commentCountAllTime ?? 0,
            collectedCount: rank?.collectedCountAllTime ?? 0,
            tippedAmountCount: rank?.tippedAmountCountAllTime ?? 0,
          },
          images: model.mode !== ModelModifier.TakenDown ? (versionImages as typeof images) : [],
          canGenerate,
          version,
        };
      })
      .filter(isDefined);

    const hiddenUsers = await Promise.all([
      HiddenUsers.getCached({ userId: ctx.user?.id }),
      BlockedByUsers.getCached({ userId: ctx.user?.id }),
      BlockedUsers.getCached({ userId: ctx.user?.id }),
    ]);
    const excludedUserIds = [...new Set(hiddenUsers.flat().map((u) => u.id))];

    return resourcesIds
      .map(({ id, resourceType }) => {
        switch (resourceType) {
          case 'article':
            const article = articles.find((article) => article.id === id);
            if (!article) return null;
            if (excludedUserIds.includes(article.user.id)) return null;

            return { resourceType: 'article' as const, ...article };
          case 'model':
            const model = completeModels.find((model) => model.id === id);
            if (!model) return null;
            if (excludedUserIds.includes(model.user.id)) return null;

            return { resourceType: 'model' as const, ...model };
        }
      })
      .filter(isDefined);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
// #endregion
export const getModelByHashesHandler = async ({ input }: { input: ModelByHashesInput }) => {
  const { hashes } = input;

  if (hashes.length === 0) {
    return [];
  }

  const modelsByHashes = await dbRead.$queryRaw<
    { userId: number; modelId: number; hash: string }[]
  >`
    SELECT m."userId",
           m."id",
           mfh."hash"
    FROM "ModelFileHash" mfh
           JOIN "ModelFile" mf ON mf."id" = mfh."fileId"
           JOIN "ModelVersion" mv ON mv."id" = mf."modelVersionId"
           JOIN "Model" m ON mv."modelId" = m.id
    WHERE LOWER(mfh."hash") IN (${Prisma.join(hashes.map((h) => h.toLowerCase()))})
      AND m."deletedAt" IS NULL;
  `;

  return modelsByHashes;
};

export async function getSimpleModelsInfiniteHandler({
  input,
  ctx,
}: {
  input: GetSimpleModelsInfiniteSchema;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { limit = 100, query, userId } = input;
    const { id: sessionUserId } = ctx.user;
    if (userId !== sessionUserId) throw throwAuthorizationError();

    const models = await dbRead.model.findMany({
      take: limit,
      where: {
        userId,
        name: query ? { contains: query, mode: 'insensitive' } : undefined,
        status: { not: ModelStatus.Deleted },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    return models;
  } catch (error) {
    throw throwDbError(error);
  }
}

export async function getModelTemplateFieldsHandler({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id: userId } = ctx.user;

    const model = await getModel({
      id: input.id,
      select: {
        description: true,
        type: true,
        checkpointType: true,
        allowCommercialUse: true,
        allowDerivatives: true,
        allowDifferentLicense: true,
        allowNoCredit: true,
        nsfw: true,
        poi: true,
        tagsOnModels: {
          select: {
            tag: { select: { id: true, name: true, isCategory: true, unlisted: true } },
          },
        },
        userId: true,
        modelVersions: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: {
            baseModel: true,
            baseModelType: true,
            settings: true,
            monetization: true,
            requireAuth: true,
            clipSkip: true,
          },
        },
      },
    });
    if (!model || model.userId !== userId) throw throwNotFoundError(`No model with id ${input.id}`);

    const modelCategories = await getCategoryTags('model');
    const { modelVersions, ...restModel } = model;
    const [version] = modelVersions;

    return {
      ...restModel,
      status: ModelStatus.Draft,
      uploadType: ModelUploadType.Created,
      tagsOnModels: restModel.tagsOnModels
        .filter(({ tag }) => !tag.unlisted)
        .map(({ tag }) => ({ ...tag, isCategory: modelCategories.some((c) => c.id === tag.id) })),
      version: version
        ? {
            ...version,
            baseModel: version.baseModel as BaseModel,
            baseModelType: version.baseModelType as BaseModelType,
            settings: version.settings as RecommendedSettingsSchema | undefined,
          }
        : undefined,
    };
  } catch (error) {
    throw throwDbError(error);
  }
}

const bountyTypeModelTypeMap: Record<string, ModelType> = {
  [BountyType.ModelCreation]: ModelType.Checkpoint,
  [BountyType.LoraCreation]: ModelType.LORA,
};

export async function getModelTemplateFromBountyHandler({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id: userId } = ctx.user;
    const awardedEntry = await dbRead.bountyEntry.findFirst({
      where: { bountyId: input.id, benefactors: { some: { userId } } },
      select: { id: true, bounty: true },
    });

    if (!awardedEntry) {
      throw throwNotFoundError(`You have no awarded entries on the bounty with id ${input.id}`);
    }

    const { bounty } = awardedEntry;

    if (!constants.bounties.supportedBountyToModels.some((t) => t === bounty.type)) {
      throw throwBadRequestError('This bounty type is not supported for model creation');
    }

    const meta = bounty.details as BountyDetailsSchema;
    const files = await getFilesByEntity({ id: awardedEntry.id, type: 'BountyEntry' });

    return {
      nsfw: bounty.nsfw,
      poi: bounty.poi,
      name: bounty.name,
      description: bounty.description,
      status: ModelStatus.Draft,
      uploadType: ModelUploadType.Created,
      type: bountyTypeModelTypeMap[bounty.type],

      version: {
        baseModel: meta.baseModel as BaseModel,
      },
      files,
    };
  } catch (error) {
    throw throwDbError(error);
  }
}

export const getModelGallerySettingsHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const settings = await getGallerySettingsByModelId({ id: input.id });
    if (!settings) throw throwNotFoundError(`No model with id ${input.id}`);

    return settings;
  } catch (e) {
    throw throwDbError(e);
  }
};

export const updateGallerySettingsHandler = async ({
  input,
  ctx,
}: {
  input: UpdateGallerySettingsInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id, gallerySettings } = input;
    const { user: sessionUser } = ctx;

    const model = await getModel({ id, select: { id: true, userId: true } });
    if (!model || (model.userId !== sessionUser.id && !sessionUser.isModerator))
      throw throwNotFoundError(`No model with id ${id}`);

    const updatedSettings = gallerySettings
      ? {
          hiddenImages: gallerySettings.hiddenImages,
          users: gallerySettings.hiddenUsers.map(({ id }) => id),
          tags: gallerySettings.hiddenTags.map(({ id }) => id),
          level: gallerySettings.level,
          pinnedPosts: gallerySettings.pinnedPosts,
        }
      : null;
    const updatedModel = await updateModelById({
      id,
      data: { gallerySettings: updatedSettings !== null ? updatedSettings : Prisma.JsonNull },
    });
    // Clear cache
    await redis.del(`${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${id}`);

    return { ...updatedModel, gallerySettings };
  } catch (error) {
    throw throwDbError(error);
  }
};

export async function toggleCheckpointCoverageHandler({
  input,
}: {
  input: ToggleCheckpointCoverageInput;
}) {
  try {
    const affectedVersionIds = await toggleCheckpointCoverage(input);
    if (affectedVersionIds) await bustMvCache(affectedVersionIds);

    await modelsSearchIndex.queueUpdate([
      { id: input.id, action: SearchIndexUpdateQueueAction.Update },
    ]);
    await dataForModelsCache.bust(input.id);

    return affectedVersionIds;
  } catch (error) {
    throw throwDbError(error);
  }
}

export async function getModelOwnerHandler({ input }: { input: GetByIdInput }) {
  const model = await getModel({ ...input, select: { user: { select: userWithCosmeticsSelect } } });
  if (!model) throw throwNotFoundError();
  return model.user;
}

export async function copyGalleryBrowsingLevelHandler({
  input,
  ctx,
}: {
  input: CopyGallerySettingsInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id: userId } = ctx.user;
    const model = await getModel({
      id: input.id,
      select: { id: true, userId: true, gallerySettings: true },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);
    if (model.userId !== userId) throw throwAuthorizationError();

    const { pinnedPosts, images, ...settings } =
      model.gallerySettings as ModelGallerySettingsSchema;

    await copyGallerySettingsToAllModelsByUser({ userId, settings });
  } catch (error) {
    throw throwDbError(error);
  }
}

export async function getModelCollectionShowcaseHandler({ input }: { input: GetByIdInput }) {
  try {
    const model = await getModel({ id: input.id, select: { id: true, meta: true } });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    const modelMeta = model.meta as ModelMeta | null;
    if (!modelMeta?.showcaseCollectionId) return null;

    const collection = await getCollectionById({ input: { id: modelMeta.showcaseCollectionId } });
    const [itemCount] = await getCollectionItemCount({
      collectionIds: [collection.id],
      status: CollectionItemStatus.ACCEPTED,
    });

    return {
      ...collection,
      itemCount: itemCount.count,
    };
  } catch (error) {
    throw throwDbError(error);
  }
}

export function setModelCollectionShowcaseHandler({
  input,
  ctx,
}: {
  input: SetModelCollectionShowcaseInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id: userId, isModerator } = ctx.user;

    return setModelShowcaseCollection({ ...input, userId, isModerator });
  } catch (error) {
    throw throwDbError(error);
  }
}

export const privateModelFromTrainingHandler = async ({
  input,
  ctx,
}: {
  input: PrivateModelFromTrainingInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const { nsfw, poi, minor, sfwOnly } = input;

    const membership = await getHighestTierSubscription(userId);
    if (!membership && !ctx.user.isModerator)
      throw throwAuthorizationError('You must have a subscription to create private models.');

    const maxPrivateModels =
      membership?.productMeta?.maxPrivateModels ??
      constants.memberships.membershipDetailsAddons[
        membership?.tier as keyof typeof constants.memberships.membershipDetailsAddons
      ]?.maxPrivateModels;

    if (!maxPrivateModels && !ctx.user.isModerator) {
      throw throwAuthorizationError('You must have a subscription to create private models.');
    }

    const currentPrivateModels = await getPrivateModelCount({ userId });

    if (currentPrivateModels >= maxPrivateModels && !ctx.user.isModerator) {
      throw throwAuthorizationError(
        `You have reached the limit of ${maxPrivateModels} private models. You may upgrade your subscription to create more.`
      );
    }

    if (nsfw && poi)
      throw throwBadRequestError('Mature content depicting actual people is not permitted.');

    if (nsfw && minor)
      throw throwBadRequestError('Mature content depicting minors is not permitted.');

    if (nsfw && sfwOnly)
      throw throwBadRequestError('Mature content on a model marked as SFW is not permitted.');

    if (!sfwOnly) throw throwBadRequestError('Private models must be set to SFW only.');

    // Check tags for multiple categories
    const { tagsOnModels } = input;
    if (tagsOnModels?.length) {
      const modelCategories = await getCategoryTags('model');
      const matchedTags = tagsOnModels.filter((tag) =>
        modelCategories.some((categoryTag) => categoryTag.name === tag.name)
      );

      if (matchedTags.length > 1)
        throw throwBadRequestError(
          `Model cannot have multiple categories. Please include only one from: ${matchedTags
            .map((tag) => tag.name)
            .join(', ')}`
        );
    }

    const model = await privateModelFromTraining({
      ...input,
      user: ctx.user,
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    if (input.id) await dataForModelsCache.bust(input.id);

    return model;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const publishPrivateModelHandler = async ({
  input,
  ctx,
}: {
  input: PublishPrivateModelInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const model = await getModel({
      id: input.modelId,
      select: { id: true, userId: true, status: true, availability: true },
    });

    if (!model) throw throwNotFoundError(`No model with id ${input.modelId}`);

    if (model.availability !== Availability.Private) {
      throw throwBadRequestError('Model is not private. Cannot publish.');
    }

    if (model.userId !== userId && !ctx.user.isModerator) {
      throw throwAuthorizationError();
    }

    const { versionIds } = await publishPrivateModel(input);
    await dataForModelsCache.bust(input.modelId);
    await bustMvCache(versionIds, input.modelId);
    await modelsSearchIndex.queueUpdate([
      { id: input.modelId, action: SearchIndexUpdateQueueAction.Update },
    ]);

    return true;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
