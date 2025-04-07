import { BaseModel } from '~/server/common/constants';
import { trainingServiceStatusSchema } from '~/server/schema/training.schema';
import { trpc } from '~/utils/trpc';

const defaultServiceStatus = trainingServiceStatusSchema.parse({});
export const useTrainingServiceStatus = () => {
  const { data: status, isLoading } = trpc.training.getStatus.useQuery(undefined, {
    cacheTime: 60,
    trpc: { context: { skipBatch: true } },
  });

  if (isLoading) return defaultServiceStatus;
  return status ?? defaultServiceStatus;
};

export const isTrainingVideo = (baseModel: BaseModel) => {
  return ['Hunyuan Video'].includes(baseModel); // TODO make this better
};
