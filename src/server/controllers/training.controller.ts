import { GetByIdInput } from '~/server/schema/base.schema';
import { getModel } from '~/server/services/model.service';
import { throwDbError } from '~/server/utils/errorHandling';

export const getModelData = async ({ input }: { input: GetByIdInput }) => {
  try {
    return await getModel({
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
  } catch (error) {
    throw throwDbError(error);
  }
};
