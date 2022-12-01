import { ModelFileType, ModelStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { Context } from '~/server/createContext';
import {
  getAllModelsSelect,
  getAllModelsWithVersionsSelect,
  modelWithDetailsSelect,
} from '~/server/selectors/model.selector';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';

import { GetByIdInput, ReportInput } from '../schema/base.schema';
import { GetAllModelsOutput } from '../schema/model.schema';
import {
  deleteModelById,
  getModel,
  getModels,
  getModelVersionsMicro,
  reportModelById,
  updateModelById,
} from '../services/model.service';

export type GetModelReturnType = AsyncReturnType<typeof getModelHandler>;
export const getModelHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  const model = await getModel({ input, user: ctx.user, select: modelWithDetailsSelect });
  if (!model) {
    throw throwNotFoundError(`No model with id ${input.id}`);
  }

  return {
    ...model,
    modelVersions: model.modelVersions.map(({ files, ...version }) => ({
      ...version,
      trainingDataFile: files.find((file) => file.type === ModelFileType.TrainingData),
      modelFile: files.find((file) => file.type === ModelFileType.Model),
    })),
  };
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
    select: getAllModelsSelect,
  });

  let nextCursor: number | undefined;
  if (items.length > input.limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    items: items.map(({ modelVersions, ...model }) => ({
      ...model,
      image: modelVersions[0]?.images[0]?.image ?? {},
    })),
  };
};

export const getModelVersionsHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const modelVersions = await getModelVersionsMicro(input);
    return modelVersions;
  } catch (error) {
    throwDbError(error);
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
  input: ReportInput;
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
