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
