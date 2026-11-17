import { isBlockedCustomModel } from '@civitai/shared/training-custom-model';
import {
  type TrainingServiceStatus,
  trainingServiceStatusSchema,
} from '~/server/schema/training.schema';
import { trpc } from '~/utils/trpc';

const defaultServiceStatus = trainingServiceStatusSchema.parse({});
export const useTrainingServiceStatus = () => {
  const { data: status, isLoading } = trpc.training.getStatus.useQuery(undefined, {
    gcTime: 60,
    trpc: { context: { skipBatch: true } },
  });

  if (isLoading) return defaultServiceStatus;
  return status ?? defaultServiceStatus;
};

/** A base the form must refuse: down in the ops list, or a custom checkpoint blocked in code. */
export const isTrainingModelBlocked = (
  status: Pick<TrainingServiceStatus, 'blockedModels'>,
  base: string
) => status.blockedModels.includes(base) || isBlockedCustomModel(base);
