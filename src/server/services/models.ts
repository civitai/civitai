import { Prisma, ModelFileType } from '@prisma/client';
import { modelWithDetailsSelect } from '../validators/models/getById';
import { handleDbError } from './errorHandling';
import { publicProcedure } from '../trpc/trpc';

type TRPCResolverParameters = Parameters<Parameters<typeof publicProcedure['query']>[0]>[0];

export const getModelById = async ({ ctx, input }: TRPCResolverParameters) => {
  try {
    const { id } = input as unknown as { id: number };
    const model = await ctx.prisma.model.findUnique({
      where: { id },
      select: modelWithDetailsSelect,
    });

    if (!model) {
      handleDbError({
        code: 'NOT_FOUND',
        message: `No model with id ${id}`,
      });
      return null;
    }

    const { modelVersions } = model;
    const transformedModel = {
      ...model,
      modelVersions: modelVersions.map(({ files, ...version }) => ({
        ...version,
        trainingDataFile: files.find((file) => file.type === ModelFileType.TrainingData),
        modelFile: files.find((file) => file.type === ModelFileType.Model),
      })),
    };

    return transformedModel;
  } catch (error) {
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
    return null;
  }
};

export type ModelById = Prisma.PromiseReturnType<typeof getModelById>;
