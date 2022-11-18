import { TRPCError } from '@trpc/server';
import { ModelFileType } from '@prisma/client';
import { GetByIdInput } from './../schema/base.schema';
import { getModel, getModels } from './../services/model.service';
import { Context } from '~/server/createContext';
import { GetAllModelsInput } from './../schema/model.schema';
import { getAllModelsSelect, modelWithDetailsSelect } from '~/server/selectors/model.selector';

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

export type GetModelsReturnType = AsyncReturnType<typeof getModelsHandler>['items'];
export const getModelsHandler = async ({
  input,
  ctx,
}: {
  input: GetAllModelsInput;
  ctx: Context;
}) => {
  input.limit = input.limit ?? 100;
  const models = await getModels({ input, user: ctx.user, select: getAllModelsSelect });

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
