import { ModelStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { Context } from '~/server/createContext';
import { GetByIdInput, ReportInput } from '~/server/schema/base.schema';
import { GetAllModelsOutput, ModelInput } from '~/server/schema/model.schema';
import { ModelReportOutput } from '~/server/schema/report.schema';
import { imageSelect } from '~/server/selectors/image.selector';
import {
  getAllModelsWithVersionsSelect,
  modelWithDetailsSelect,
} from '~/server/selectors/model.selector';
import {
  createModel,
  deleteModelById,
  getModel,
  getModels,
  getModelVersionsMicro,
  reportModelById,
  updateModel,
  updateModelById,
} from '~/server/services/model.service';
import {
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';

export type GetModelReturnType = AsyncReturnType<typeof getModelHandler>;
export const getModelHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
    const model = await getModel({ input, user: ctx.user, select: modelWithDetailsSelect });
    if (!model) {
      throw throwNotFoundError(`No model with id ${input.id}`);
    }

    return model;
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
      modelVersions: {
        orderBy: { index: 'asc' },
        take: 1,
        select: {
          createdAt: true,
          images: {
            orderBy: {
              index: 'asc',
            },
            take: 1,
            select: {
              image: {
                select: imageSelect,
              },
            },
          },
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
    },
  });

  let nextCursor: number | undefined;
  if (items.length > input.limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    items: items.map(({ modelVersions, ...model }) => {
      const rank = model.rank as Record<string, number>;
      return {
        ...model,
        rank: {
          downloadCount: rank[`downloadCount${input.period}`],
          favoriteCount: rank[`favoriteCount${input.period}`],
          commentCount: rank[`commentCount${input.period}`],
          ratingCount: rank[`ratingCount${input.period}`],
          rating: rank[`rating${input.period}`],
        },
        image: modelVersions[0]?.images[0]?.image ?? {},
        lastVersionCreatedAt: modelVersions[0]?.createdAt,
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
    else throwDbError(error);
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

export const reportModelHandler = async ({
  input,
  ctx,
}: {
  input: ModelReportOutput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    await reportModelById({ ...input, userId: ctx.user.id });
  } catch (error) {
    throwDbError(error);
  }
};

export const deleteModelHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const { id } = input;
    const model = await deleteModelById({ id });

    if (!model) {
      throw throwNotFoundError(`No model with id ${id}`);
    }

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
