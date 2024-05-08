import {
  BountyType,
  MetricTimeframe,
  ModelHashType,
  ModelModifier,
  ModelStatus,
  ModelType,
  ModelUploadType,
  Prisma,
} from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { CommandResourcesAdd, ResourceType } from '~/components/CivitaiLink/shared-types';
import { BaseModel, BaseModelType, ModelFileType, constants } from '~/server/common/constants';
import { ModelSort, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { Context } from '~/server/createContext';

import { dbRead, dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import { getInfiniteArticlesSchema } from '~/server/schema/article.schema';
import { GetAllSchema, GetByIdInput, UserPreferencesInput } from '~/server/schema/base.schema';
import {
  ModelVersionMeta,
  RecommendedSettingsSchema,
  TrainingDetailsObj,
} from '~/server/schema/model-version.schema';
import {
  ChangeModelModifierSchema,
  DeclineReviewSchema,
  DeleteModelSchema,
  FindResourcesToAssociateSchema,
  GetAllModelsOutput,
  GetAssociatedResourcesInput,
  GetDownloadSchema,
  GetModelVersionsSchema,
  GetSimpleModelsInfiniteSchema,
  ModelByHashesInput,
  ModelMeta,
  ModelUpsertInput,
  PublishModelSchema,
  ReorderModelVersionsSchema,
  ToggleCheckpointCoverageInput,
  ToggleModelLockInput,
  UnpublishModelSchema,
  UpdateGallerySettingsInput,
  getAllModelsSchema,
} from '~/server/schema/model.schema';
import { modelsSearchIndex } from '~/server/search-index';
import {
  associatedResourceSelect,
  getAllModelsWithVersionsSelect,
  modelWithDetailsSelect,
} from '~/server/selectors/model.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { getArticles } from '~/server/services/article.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { getDownloadFilename, getFilesByEntity } from '~/server/services/file.service';
import { getImagesForModelVersion } from '~/server/services/image.service';
import {
  deleteModelById,
  getDraftModelsByUserId,
  getModel,
  getModelVersionsMicro,
  getModels,
  getModelsWithImagesAndModelVersions,
  getTrainingModelsByUserId,
  getVaeFiles,
  permaDeleteModelById,
  publishModelById,
  restoreModelById,
  toggleLockModel,
  unpublishModelById,
  updateModelById,
  updateModelEarlyAccessDeadline,
  upsertModel,
  getGallerySettingsByModelId,
  toggleCheckpointCoverage,
} from '~/server/services/model.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { getCategoryTags } from '~/server/services/system-cache';
import { getEarlyAccessDeadline } from '~/server/utils/early-access-helpers';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { getDownloadUrl } from '~/utils/delivery-worker';
import { isDefined } from '~/utils/type-guards';
import { redis } from '../redis/client';
import { modelHashSelect } from './../selectors/modelHash.selector';
import {
  deleteResourceDataCache,
  getUnavailableResources,
} from '../services/generation/generation.service';
import { BountyDetailsSchema } from '../schema/bounty.schema';
import {
  allBrowsingLevelsFlag,
  getIsSafeBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';

export type GetModelReturnType = AsyncReturnType<typeof getModelHandler>;
export const getModelHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
    const model = await getModel({
      ...input,
      user: ctx.user,
      select: modelWithDetailsSelect,
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    const features = getFeatureFlags({ user: ctx.user });
    const filteredVersions = model.modelVersions.filter((version) => {
      const isOwner = ctx.user?.id === model.user.id || ctx.user?.isModerator;
      if (isOwner) return true;

      return version.status === ModelStatus.Published;
    });
    const modelVersionIds = filteredVersions.map((version) => version.id);
    const posts = await dbRead.post.findMany({
      where: {
        modelVersionId: { in: modelVersionIds },
        userId: model.user.id,
      },
      select: { id: true, modelVersionId: true },
      orderBy: { id: 'asc' },
    });

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

    return {
      ...model,
      metrics: undefined,
      rank: {
        downloadCountAllTime: metrics?.downloadCount ?? 0,
        favoriteCountAllTime: metrics?.favoriteCount ?? 0,
        thumbsUpCountAllTime: metrics?.thumbsUpCount ?? 0,
        thumbsDownCountAllTime: metrics?.thumbsDownCount ?? 0,
        commentCountAllTime: metrics?.commentCount ?? 0,
        ratingCountAllTime: metrics?.ratingCount ?? 0,
        ratingAllTime: Number(metrics?.rating?.toFixed(2) ?? 0),
        tippedAmountCountAllTime: metrics?.tippedAmountCount ?? 0,
        imageCountAllTime: metrics?.imageCount ?? 0,
        collectedCountAllTime: metrics?.collectedCount ?? 0,
        generationCountAllTime: metrics?.generationCount ?? 0,
      },
      canGenerate: filteredVersions.some(
        (version) =>
          !!version.generationCoverage?.covered &&
          unavailableGenResources.indexOf(version.id) === -1
      ),
      hasSuggestedResources: suggestedResources > 0,
      meta: model.meta as ModelMeta | null,
      tagsOnModels: model.tagsOnModels
        .filter(({ tag }) => !tag.unlisted)
        .map(({ tag }) => ({
          tag: {
            id: tag.id,
            name: tag.name,
            isCategory: modelCategories.some((c) => c.id === tag.id),
          },
        })),
      modelVersions: filteredVersions.map((version) => {
        let earlyAccessDeadline = features.earlyAccessModel
          ? getEarlyAccessDeadline({
              versionCreatedAt: version.createdAt,
              publishedAt: model.publishedAt,
              earlyAccessTimeframe: version.earlyAccessTimeFrame,
            })
          : undefined;
        if (earlyAccessDeadline && new Date() > earlyAccessDeadline)
          earlyAccessDeadline = undefined;
        const canDownload =
          model.mode !== ModelModifier.Archived &&
          (!earlyAccessDeadline || !!ctx.user?.tier || !!ctx.user?.isModerator);
        const canGenerate =
          !!version.generationCoverage?.covered &&
          unavailableGenResources.indexOf(version.id) === -1;

        // sort version files by file type, 'Model' type goes first
        const vaeFile = vaeFiles.filter((x) => x.modelVersionId === version.vaeId);
        version.files.push(...vaeFile);
        const files = version.files
          .filter((x) => x.visibility === 'Public' || canManage)
          .sort((a, b) => {
            const aType = a.type as ModelFileType;
            const bType = b.type as ModelFileType;

            if (constants.modelFileOrder[aType] < constants.modelFileOrder[bType]) return -1;
            else if (constants.modelFileOrder[aType] > constants.modelFileOrder[bType]) return 1;
            else return 0;
          });

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
            ratingCountAllTime: versionMetrics?.ratingCount ?? 0,
            ratingAllTime: Number(versionMetrics?.rating?.toFixed(2) ?? 0),
            thumbsUpCountAllTime: versionMetrics?.thumbsUpCount ?? 0,
            thumbsDownCountAllTime: versionMetrics?.thumbsDownCount ?? 0,
          },
          posts: posts.filter((x) => x.modelVersionId === version.id).map((x) => ({ id: x.id })),
          hashes,
          earlyAccessDeadline,
          canDownload,
          canGenerate,
          files: files as Array<
            Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }
          >,
          baseModel: version.baseModel as BaseModel,
          baseModelType: version.baseModelType as BaseModelType,
          meta: version.meta as ModelVersionMeta,
          trainingDetails: version.trainingDetails as TrainingDetailsObj | undefined,
          settings: version.settings as RecommendedSettingsSchema | undefined,
          recommendedResources: version.recommendedResources.map(({ resource, settings }) => ({
            id: resource.id,
            name: resource.name,
            baseModel: resource.baseModel,
            trainedWords: resource.trainedWords,
            modelId: resource.model.id,
            modelName: resource.model.name,
            modelType: resource.model.type,
            strength: (settings as RecommendedSettingsSchema)?.strength,
          })),
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
    while (results.length <= (input.limit ?? 100) && loopCount < 3) {
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

  const parsedResults = {
    ...results,
    items: results.items.map(({ modelVersions = [], ...model }) => {
      const [version] = modelVersions;

      return {
        ...model,
        meta: model.meta as ModelMeta | null,
        modelVersion: version
          ? { ...version, meta: version.meta as ModelVersionMeta | null }
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
    const { nsfw, poi } = input;

    if (nsfw && poi)
      throw throwBadRequestError('Mature content depicting actual people is not permitted.');

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
            .join(', ')} `
        );
    }

    const model = await upsertModel({ ...input, userId, isModerator: ctx.user.isModerator });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    await ctx.track.modelEvent({
      type: input.id ? 'Update' : 'Create',
      modelId: model.id,
      nsfw: !getIsSafeBrowsingLevel(model.nsfwLevel),
    });

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
    const updatedModel = await unpublishModelById({ ...input, meta, user: ctx.user });

    await ctx.track.modelEvent({
      type: 'Unpublish',
      modelId: id,
      nsfw: model.nsfw,
    });

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
    const model = await deleteModel({ id, userId: ctx.user.id });
    if (!model) throw throwNotFoundError(`No model with id ${id}`);

    await ctx.track.modelEvent({
      type: permanently ? 'PermanentDelete' : 'Delete',
      modelId: model.id,
      nsfw: !getIsSafeBrowsingLevel(model.nsfwLevel),
    });

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

    const vaeIds = rawResults.items
      .flatMap(({ modelVersions }) => modelVersions.map(({ vaeId }) => vaeId))
      .filter(isDefined);
    const vaeFiles = await getVaeFiles({ vaeIds });

    const modelIds = rawResults.items.map(({ id }) => id);
    const metrics = await dbRead.modelMetric.findMany({
      where: { modelId: { in: modelIds }, timeframe: MetricTimeframe.AllTime },
    });

    function getStatsForModel(modelId: number) {
      const stats = metrics.find((x) => x.modelId === modelId);
      return {
        downloadCount: stats?.downloadCount ?? 0,
        favoriteCount: stats?.favoriteCount ?? 0,
        thumbsUpCount: stats?.thumbsUpCount ?? 0,
        thumbsDownCount: stats?.thumbsDownCount ?? 0,
        commentCount: stats?.commentCount ?? 0,
        ratingCount: stats?.ratingCount ?? 0,
        rating: Number(stats?.rating?.toFixed(2) ?? 0),
        tippedAmountCount: stats?.tippedAmountCount ?? 0,
      };
    }

    const results = {
      count: rawResults.count,
      items: rawResults.items.map(({ modelVersions, ...model }) => ({
        ...model,
        modelVersions: modelVersions.map(({ metrics, files, ...modelVersion }) => {
          const vaeFile = vaeFiles.filter((x) => x.modelVersionId === modelVersion.vaeId);
          files.push(...vaeFile);
          return {
            ...modelVersion,
            files,
            stats: {
              downloadCount: metrics[0]?.downloadCount ?? 0,
              ratingCount: metrics[0]?.ratingCount ?? 0,
              rating: Number(metrics[0]?.rating?.toFixed(2) ?? 0),
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
  ctx: Context;
}) => {
  try {
    const fileWhere: Prisma.ModelFileWhereInput = {};
    if (type) fileWhere.type = type;
    if (format) fileWhere.metadata = { path: ['format'], equals: format };

    // const prioritizeSafeImages = !ctx.user || (ctx.user.showNsfw && ctx.user.blurNsfw);

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
    if (userId) {
      await dbWrite.$executeRaw`
        -- Update user history
        INSERT INTO "DownloadHistory" ("userId", "modelVersionId", "downloadAt", hidden)
        VALUES (${userId}, ${modelVersion.id}, ${now}, false)
        ON CONFLICT ("userId", "modelVersionId") DO UPDATE SET "downloadAt" = excluded."downloadAt"
      `;
    }
    ctx.track.modelVersionEvent({
      type: 'Download',
      modelId: modelVersion.model.id,
      modelVersionId: modelVersion.id,
      nsfw: modelVersion.model.nsfw,
      time: now,
    });

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
  input: GetAllSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    return await getTrainingModelsByUserId({
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
            id: true,
            trainingDetails: true,
            trainingStatus: true,
            files: {
              select: {
                id: true,
                url: true,
                type: true,
                metadata: true,
                sizeKB: true,
              },
              where: { type: { equals: 'Training Data' } },
            },
          },
        },
      },
    });
  } catch (error) {
    throw throwDbError(error);
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
        decliendAt: new Date().toISOString(),
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
    if (model.mode === mode) throw throwBadRequestError(`Model is already ${mode}`);
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

    const [{ items: models }, { items: articles }] = await Promise.all([
      modelResources?.length > 0
        ? getModels({
            user,
            input: modelInput,
            select: {
              id: true,
              name: true,
              type: true,
              status: true,
              createdAt: true,
              lastVersionAt: true,
              publishedAt: true,
              locked: true,
              earlyAccessDeadline: true,
              mode: true,
              nsfwLevel: true,
              metrics: {
                select: {
                  downloadCount: true,
                  favoriteCount: true,
                  commentCount: true,
                  ratingCount: true,
                  rating: true,
                  thumbsUpCount: true,
                  thumbsDownCount: true,
                },
                where: { timeframe: period },
              },
              modelVersions: {
                orderBy: { index: 'asc' },
                take: 1,
                where: { status: ModelStatus.Published },
                select: {
                  id: true,
                  earlyAccessTimeFrame: true,
                  createdAt: true,
                  baseModel: true,
                  baseModelType: true,
                  generationCoverage: { select: { covered: true } },
                },
              },
              user: { select: simpleUserSelect },
              hashes: {
                select: modelHashSelect,
                where: {
                  hashType: ModelHashType.SHA256,
                  fileType: { in: ['Model', 'Pruned Model'] as ModelFileType[] },
                },
              },
            },
          })
        : { items: [] },
      articleResources?.length > 0
        ? getArticles({ ...articleInput, sessionUser: user })
        : { items: [] },
      ,
    ]);

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

    const completeModels = models
      .map(({ hashes, modelVersions, metrics, ...model }) => {
        const [version] = modelVersions;
        if (!version) return null;
        const versionImages = images.filter((i) => i.modelVersionId === version.id);
        const showImageless =
          (user?.isModerator || model.user.id === user?.id) &&
          (modelInput.user || modelInput.username);
        if (!versionImages.length && !showImageless) return null;
        const canGenerate = !!version.generationCoverage?.covered;

        return {
          ...model,
          hashes: hashes.map((hash) => hash.hash.toLowerCase()),
          rank: {
            downloadCount: metrics[0]?.downloadCount ?? 0,
            favoriteCount: metrics[0]?.favoriteCount ?? 0,
            thumbsUpCount: metrics[0]?.thumbsUpCount ?? 0,
            thumbsDownCount: metrics[0]?.thumbsDownCount ?? 0,
            commentCount: metrics[0]?.commentCount ?? 0,
            ratingCount: metrics[0]?.ratingCount ?? 0,
            rating: metrics[0]?.rating ?? 0,
          },
          images: model.mode !== ModelModifier.TakenDown ? (versionImages as typeof images) : [],
          canGenerate,
          version,
        };
      })
      .filter(isDefined);

    return resourcesIds
      .map(({ id, resourceType }) => {
        switch (resourceType) {
          case 'article':
            const article = articles.find((article) => article.id === id);
            if (!article) return null;
            return { resourceType: 'article' as const, ...article };
          case 'model':
            const model = completeModels.find((model) => model.id === id);
            if (!model) return null;
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
      SELECT
        m."userId",
        m."id",
        mfh."hash"
      FROM "ModelFileHash" mfh
      JOIN "ModelFile" mf ON mf."id" = mfh."fileId"
      JOIN "ModelVersion" mv ON mv."id" = mf."modelVersionId"
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE LOWER(mfh."hash") IN (${Prisma.join(hashes.map((h) => h.toLowerCase()))});
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
          images: gallerySettings.hiddenImages,
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
    await redis.del(`model:gallery-settings:${id}`);

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
    if (affectedVersionIds) await deleteResourceDataCache(affectedVersionIds);

    await modelsSearchIndex.queueUpdate([
      { id: input.id, action: SearchIndexUpdateQueueAction.Update },
    ]);

    return affectedVersionIds;
  } catch (error) {
    throw throwDbError(error);
  }
}
