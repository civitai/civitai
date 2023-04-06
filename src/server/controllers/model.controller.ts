import { modelHashSelect } from './../selectors/modelHash.selector';
import { ModelStatus, ModelHashType, Prisma, UserActivityType } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { dbWrite, dbRead } from '~/server/db/client';
import { Context } from '~/server/createContext';
import { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import {
  DeleteModelSchema,
  GetAllModelsOutput,
  GetDownloadSchema,
  ModelInput,
  ModelMeta,
  ModelUpsertInput,
  PublishModelSchema,
  ReorderModelVersionsSchema,
  ToggleModelLockInput,
  UnpublishModelSchema,
} from '~/server/schema/model.schema';
import {
  getAllModelsWithVersionsSelect,
  modelWithDetailsSelect,
} from '~/server/selectors/model.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import {
  createModel,
  deleteModelById,
  getDraftModelsByUserId,
  getModel,
  getModels,
  getModelVersionsMicro,
  permaDeleteModelById,
  publishModelById,
  restoreModelById,
  toggleLockModel,
  updateModel,
  updateModelById,
  upsertModel,
} from '~/server/services/model.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { getEarlyAccessDeadline, isEarlyAccess } from '~/server/utils/early-access-helpers';
import { BaseModel, constants, ModelFileType } from '~/server/common/constants';
import { getDownloadFilename } from '~/pages/api/download/models/[modelVersionId]';
import { getGetUrl } from '~/utils/s3-utils';
import { CommandResourcesAdd, ResourceType } from '~/components/CivitaiLink/shared-types';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { isDefined } from '~/utils/type-guards';
import { getHiddenImagesForUser } from '~/server/services/user-cache.service';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { getDownloadUrl } from '~/utils/delivery-worker';
import { ModelSort } from '~/server/common/enums';

export type GetModelReturnType = AsyncReturnType<typeof getModelHandler>;
export const getModelHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
    const model = await getModel({
      input,
      user: ctx.user,
      select: { ...modelWithDetailsSelect, meta: true },
    });
    if (!model) {
      throw throwNotFoundError(`No model with id ${input.id}`);
    }

    const features = getFeatureFlags({ user: ctx.user });
    const modelVersionIds = model.modelVersions.map((version) => version.id);
    const posts = await dbRead.post.findMany({
      where: {
        modelVersionId: { in: modelVersionIds },
        userId: model.user.id,
      },
      select: { id: true, modelVersionId: true },
      orderBy: { id: 'asc' },
    });

    return {
      ...model,
      meta: model.meta as ModelMeta | null,
      modelVersions: model.modelVersions.map((version) => {
        let earlyAccessDeadline = features.earlyAccessModel
          ? getEarlyAccessDeadline({
              versionCreatedAt: version.createdAt,
              publishedAt: model.publishedAt,
              earlyAccessTimeframe: version.earlyAccessTimeFrame,
            })
          : undefined;
        if (earlyAccessDeadline && new Date() > earlyAccessDeadline)
          earlyAccessDeadline = undefined;
        const canDownload = !earlyAccessDeadline || !!ctx.user?.tier || !!ctx.user?.isModerator;

        // sort version files by file type, 'Model' type goes first
        const files = [...version.files].sort((a, b) => {
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

        return {
          ...version,
          posts: posts.filter((x) => x.modelVersionId === version.id).map((x) => ({ id: x.id })),
          hashes,
          earlyAccessDeadline,
          canDownload,
          files: files as Array<
            Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }
          >,
          baseModel: version.baseModel as BaseModel,
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
  input.limit = input.limit ?? 100;
  const take = input.limit + 1;

  const { items } = await getModels({
    input: { ...input, take },
    user: ctx.user,
    select: {
      id: true,
      name: true,
      type: true,
      nsfw: true,
      status: true,
      createdAt: true,
      lastVersionAt: true,
      publishedAt: true,
      locked: true,
      rank: {
        select: {
          [`downloadCount${input.period}`]: true,
          [`favoriteCount${input.period}`]: true,
          [`commentCount${input.period}`]: true,
          [`ratingCount${input.period}`]: true,
          [`rating${input.period}`]: true,
        },
      },
      modelVersions: {
        orderBy: { index: 'asc' },
        take: 1,
        select: {
          id: true,
          earlyAccessTimeFrame: true,
          createdAt: true,
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
  });

  const modelVersionIds = items.flatMap((m) => m.modelVersions).map((m) => m.id);
  const images = !!modelVersionIds.length
    ? await getImagesForModelVersion({
        modelVersionIds,
        excludedTagIds: input.excludedImageTagIds,
        excludedIds: await getHiddenImagesForUser({ userId: ctx.user?.id }),
        excludedUserIds: input.excludedUserIds,
        currentUserId: ctx.user?.id,
      })
    : [];

  let nextCursor: number | undefined;
  if (items.length > input.limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  const result = {
    nextCursor,
    items: items
      .map(({ publishedAt, hashes, modelVersions, ...model }) => {
        const [version] = modelVersions;
        if (!version) return null;
        const [image] = images.filter((i) => i.modelVersionId === version.id);
        const showImageless =
          (ctx.user?.isModerator || model.user.id === ctx.user?.id) &&
          (input.user || input.username);
        if (!image && !showImageless) return null;

        const rank = model.rank; // NOTE: null before metrics kick in
        const earlyAccess =
          !version ||
          isEarlyAccess({
            versionCreatedAt: version.createdAt,
            publishedAt,
            earlyAccessTimeframe: version.earlyAccessTimeFrame,
          });
        return {
          ...model,
          hashes: hashes.map((hash) => hash.hash.toLowerCase()),
          rank: {
            downloadCount: rank?.[`downloadCount${input.period}`] ?? 0,
            favoriteCount: rank?.[`favoriteCount${input.period}`] ?? 0,
            commentCount: rank?.[`commentCount${input.period}`] ?? 0,
            ratingCount: rank?.[`ratingCount${input.period}`] ?? 0,
            rating: rank?.[`rating${input.period}`] ?? 0,
          },
          image: image as (typeof images)[0] | undefined,
          earlyAccess,
        };
      })
      .filter(isDefined),
  };
  return result;
};

export const getModelsPagedSimpleHandler = async ({
  input,
  ctx,
}: {
  input: GetAllModelsOutput;
  ctx: Context;
}) => {
  const { limit = DEFAULT_PAGE_SIZE, page } = input || {};
  const { take, skip } = getPagination(limit, page);
  const results = await getModels({
    input: { ...input, take, skip },
    user: ctx.user,
    select: {
      id: true,
      name: true,
      nsfw: true,
    },
  });
  return getPagingData(results, take, page);
};

export const getModelVersionsHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const modelVersions = await getModelVersionsMicro(input);
    return modelVersions;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const createModelHandler = async ({
  input,
  ctx,
}: {
  input: ModelInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { user } = ctx;
    const model = await createModel({ ...input, userId: user.id });

    return model;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
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
    const model = await upsertModel({ ...input, userId });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    return model;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const updateModelHandler = async ({
  ctx,
  input,
}: {
  input: ModelInput & { id: number };
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;
  const { id, poi, nsfw } = input;

  if (poi && nsfw) {
    throw throwBadRequestError(
      `Models or images depicting real people in NSFW contexts are not permitted.`
    );
  }

  try {
    const userId = user.id;
    const model = await updateModel({ ...input, userId });
    if (!model) {
      throw throwNotFoundError(`No model with id ${id}`);
    }

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
      select: { status: true, meta: true },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    const { isModerator } = ctx.user;
    if (model.status === ModelStatus.UnpublishedViolation && !isModerator)
      throw throwAuthorizationError(
        'You are not authorized to publish this model because it has been reported as ToS Violation'
      );

    const republishing = model.status !== ModelStatus.Draft;
    const { needsReview, unpublishedReason, unpublishedAt, ...meta } =
      (model.meta as ModelMeta | null) || {};
    const updatedModel = await publishModelById({ ...input, meta, republishing });

    return updatedModel;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export const unpublishModelHandler = async ({ input }: { input: UnpublishModelSchema }) => {
  try {
    const { id, reason } = input;
    const model = await dbRead.model.findUnique({
      where: { id },
      select: { meta: true },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    const meta = (model.meta as ModelMeta | null) || {};
    const updatedModel = await updateModelById({
      id,
      data: {
        status: reason ? ModelStatus.UnpublishedViolation : ModelStatus.Unpublished,
        meta: reason
          ? { ...meta, unpublishedReason: reason, unpublishedAt: new Date().toISOString() }
          : undefined,
        modelVersions: {
          updateMany: {
            where: { status: ModelStatus.Published },
            data: { status: ModelStatus.Unpublished },
          },
        },
      },
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
  const { limit = DEFAULT_PAGE_SIZE, page, ...queryInput } = input;
  const { take, skip } = getPagination(limit, page);
  try {
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
      include: ['meta'],
    });

    const results = {
      count: rawResults.count,
      items: rawResults.items.map(({ rank, modelVersions, ...model }) => ({
        ...model,
        modelVersions: modelVersions.map((modelVersion) => ({
          ...modelVersion,
          images: images
            .filter((image) => image.modelVersionId === modelVersion.id)
            .map(({ modelVersionId, name, userId, ...image }) => ({
              ...image,
            })),
        })),
        stats: {
          downloadCount: rank?.downloadCountAllTime ?? 0,
          favoriteCount: rank?.favoriteCountAllTime ?? 0,
          commentCount: rank?.commentCountAllTime ?? 0,
          ratingCount: rank?.ratingCountAllTime ?? 0,
          rating: Number(rank?.ratingAllTime?.toFixed(2) ?? 0),
        },
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

    const prioritizeSafeImages = !ctx.user || (ctx.user.showNsfw && ctx.user.blurNsfw);

    const modelVersion = await dbRead.modelVersion.findFirst({
      where: { modelId, id: modelVersionId },
      select: {
        id: true,
        model: {
          select: { id: true, name: true, type: true, status: true, userId: true },
        },
        images: {
          select: {
            image: { select: { url: true } },
          },
          orderBy: prioritizeSafeImages
            ? [{ image: { nsfw: 'asc' } }, { index: 'asc' }]
            : [{ index: 'asc' }],
          take: 1,
        },
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
      isMod || modelVersion?.model?.status === 'Published' || modelVersion.model.userId === userId;
    if (!canDownload) throw throwNotFoundError();

    await dbWrite.userActivity.create({
      data: {
        userId,
        activity: UserActivityType.ModelDownload,
        details: {
          modelId: modelVersion.model.id,
          modelVersionId: modelVersion.id,
        },
      },
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
        previewImage: modelVersion.images[0]?.image?.url,
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
          url: (await getGetUrl(additionalFile.url, { fileName: additionalFileName })).url,
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
      input: { id },
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
      select: { id: true, name: true, status: true, type: true, meta: true, userId: true },
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
