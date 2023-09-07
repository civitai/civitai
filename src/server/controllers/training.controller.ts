import { TRPCError } from '@trpc/server';
import { GetByIdInput } from '~/server/schema/base.schema';
import { getModel } from '~/server/services/model.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export const getModelData = async ({ input }: { input: GetByIdInput }) => {
  try {
    const model = await getModel({
      id: input.id,
      select: {
        id: true,
        name: true,
        status: true,
        type: true,
        uploadType: true,
        modelVersions: {
          select: {
            id: true,
            name: true,
            baseModel: true,
            trainingStatus: true,
            trainingDetails: true,
            files: {
              select: {
                id: true,
                url: true,
                type: true,
                metadata: true,
                sizeKB: true,
                visibility: true,
              },
              where: { type: { equals: 'Training Data' } },
            },
          },
        },
      },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    return model;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
