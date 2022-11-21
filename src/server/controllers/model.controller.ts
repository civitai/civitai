import { TRPCError } from '@trpc/server';
import { ModelFileType, ModelStatus } from '@prisma/client';

import { Context } from '~/server/createContext';
import { getAllModelsSelect, modelWithDetailsSelect } from '~/server/selectors/model.selector';
import { handleDbError } from '~/server/utils/errorHandling';

import { GetByIdInput } from '../schema/base.schema';
import { GetAllModelsInput, ReportModelInput } from '../schema/model.schema';
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
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `No model with id ${input.id}`,
    });
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
  input: GetAllModelsInput;
  ctx: Context;
}) => {
  input.limit = input.limit ?? 100;
  const limit = input.limit + 1;
  const models = await getModels({
    input: { ...input, limit },
    user: ctx.user,
    select: getAllModelsSelect,
  });

  let nextCursor: number | undefined;
  if (models.length > input.limit) {
    const nextItem = models.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    items: models.map(({ modelVersions, ...model }) => ({
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
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
  }
};

export const unpublishModelHandler = async ({ input }: { input: GetByIdInput }) => {
  const { id } = input;
  const model = await updateModelById({ id, data: { status: ModelStatus.Unpublished } });

  if (!model) {
    return handleDbError({
      code: 'NOT_FOUND',
      message: `No model with id ${id}`,
    });
  }

  return model;
};

export const reportModelHanlder = async ({
  input,
  ctx,
}: {
  input: ReportModelInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { id, reason } = input;

  try {
    await reportModelById({ id, reason, userId: ctx.user.id });
  } catch (error) {
    handleDbError({
      code: 'INTERNAL_SERVER_ERROR',
      error,
    });
  }
};

export const deleteModelHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const { id } = input;
    const model = await deleteModelById({ id });

    if (!model) {
      throw handleDbError({
        code: 'NOT_FOUND',
        message: `No model with id ${id}`,
      });
    }

    return model;
  } catch (error) {
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
  }
};
