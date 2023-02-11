import { modelHashSelect } from './../selectors/modelHash.selector';
import { ModelStatus, ModelHashType } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { prisma } from '~/server/db/client';
import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import { DeleteModelSchema, GetAllModelsOutput, ModelInput } from '~/server/schema/model.schema';
import { imageSelect } from '~/server/selectors/image.selector';
import {
  getAllModelsWithVersionsSelect,
  modelWithDetailsSelect,
} from '~/server/selectors/model.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import {
  createModel,
  deleteModelById,
  getModel,
  getModels,
  getModelVersionsMicro,
  permaDeleteModelById,
  restoreModelById,
  updateModel,
  updateModelById,
} from '~/server/services/model.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { env } from '~/env/server.mjs';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { getEarlyAccessDeadline, isEarlyAccess } from '~/server/utils/early-access-helpers';

export type GetModelReturnType = AsyncReturnType<typeof getModelHandler>;
export const getModelHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  const showNsfw = ctx.user?.showNsfw ?? env.UNAUTHENTICATE_LIST_NSFW;
  const prioritizeSafeImages = !ctx.user || (ctx.user.showNsfw && ctx.user.blurNsfw);
  try {
    const model = await getModel({
      input,
      user: ctx.user,
      select: modelWithDetailsSelect(showNsfw),
    });
    if (!model) {
      throw throwNotFoundError(`No model with id ${input.id}`);
    }

    const isOwnerOrModerator = model.user.id === ctx.user?.id || ctx.user?.isModerator;
    const features = getFeatureFlags({ user: ctx.user });

    return {
      ...model,
      modelVersions: model.modelVersions.map((version) => {
        const images =
          !isOwnerOrModerator && prioritizeSafeImages
            ? version.images
                .flatMap((x) => x.image)
                .sort((a, b) => {
                  return a.nsfw === b.nsfw ? 0 : a.nsfw ? 1 : -1;
                })
            : version.images.flatMap((x) => x.image);
        let earlyAccessDeadline = features.earlyAccessModel
          ? getEarlyAccessDeadline({
              versionCreatedAt: version.createdAt,
              publishedAt: model.publishedAt,
              earlyAccessTimeframe: version.earlyAccessTimeFrame,
            })
          : undefined;
        if (earlyAccessDeadline && new Date() > earlyAccessDeadline)
          earlyAccessDeadline = undefined;
        const canDownload = !earlyAccessDeadline || ctx.user?.tier;
        return {
          ...version,
          images,
          earlyAccessDeadline,
          canDownload,
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
  const prioritizeSafeImages =
    input.hideNSFW || (ctx.user?.showNsfw ?? false) === false || ctx.user?.blurNsfw;
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
      modelVersions: {
        orderBy: { index: 'asc' },
        take: 1,
        select: {
          earlyAccessTimeFrame: true,
          createdAt: true,
          images: {
            where: { image: { tosViolation: false } },
            orderBy: prioritizeSafeImages
              ? [{ image: { nsfw: 'asc' } }, { index: 'asc' }]
              : [{ index: 'asc' }],
            take: 1,
            select: {
              image: {
                select: imageSelect,
              },
            },
          },
        },
      },
      reportStats: {
        select: {
          ownershipPending: true,
        },
      },
      rank: {
        select: {
          [`downloadCount${input.period}`]: true,
          [`favoriteCount${input.period}`]: true,
          [`commentCount${input.period}`]: true,
          [`ratingCount${input.period}`]: true,
          [`rating${input.period}`]: true,
        },
      },
      user: { select: simpleUserSelect },
      hashes: {
        select: modelHashSelect,
        where: { hashType: ModelHashType.SHA256 },
      },
    },
  });

  let nextCursor: number | undefined;
  if (items.length > input.limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    items: items.map(({ modelVersions, reportStats, publishedAt, ...model }) => {
      const rank = model.rank as Record<string, number>;
      const latestVersion = modelVersions[0];
      const earlyAccess =
        !latestVersion ||
        isEarlyAccess({
          versionCreatedAt: latestVersion.createdAt,
          publishedAt,
          earlyAccessTimeframe: latestVersion.earlyAccessTimeFrame,
        });
      return {
        ...model,
        rank: {
          downloadCount: rank[`downloadCount${input.period}`],
          favoriteCount: rank[`favoriteCount${input.period}`],
          commentCount: rank[`commentCount${input.period}`],
          ratingCount: rank[`ratingCount${input.period}`],
          rating: rank[`rating${input.period}`],
        },
        image: latestVersion?.images[0]?.image ?? {},
        earlyAccess,
      };
    }),
  };
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
    throwDbError(error);
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
    const model = await updateModel({ ...input, userId: user.id });
    if (!model) {
      throw throwNotFoundError(`No model with id ${id}`);
    }

    return model;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const unpublishModelHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const model = await updateModelById({ ...input, data: { status: ModelStatus.Unpublished } });

    if (!model) {
      throw throwNotFoundError(`No model with id ${input.id}`);
    }

    return model;
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
    const model = await deleteModel({ id });
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
  input: GetAllModelsOutput;
  ctx: Context;
}) => {
  const { limit = DEFAULT_PAGE_SIZE, page, ...queryInput } = input;
  const { take, skip } = getPagination(limit, page);
  try {
    const results = await getModels({
      input: { ...queryInput, take, skip },
      user: ctx.user,
      select: getAllModelsWithVersionsSelect,
      count: true,
    });

    return getPagingData(results, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};

// TODO - TEMP HACK for reporting modal
export const getModelReportDetailsHandler = async ({ input: { id } }: { input: GetByIdInput }) => {
  try {
    return await prisma.model.findUnique({
      where: { id },
      select: { userId: true, reportStats: { select: { ownershipPending: true } } },
    });
  } catch (error) {}
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
    throw throwDbError(error);
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
