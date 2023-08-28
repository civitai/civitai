import { z } from 'zod';
import {
  trainingDetailsBaseModels,
  trainingDetailsParams,
} from '~/server/schema/model-version.schema';

export type CreateTrainingRequestInput = z.infer<typeof createTrainingRequestSchema>;
export const createTrainingRequestSchema = z.object({
  model: z.enum(trainingDetailsBaseModels),
  trainingData: z.string().url(),
  // callbackUrl: z.string(),
  // properties: z.object({}),
  params: trainingDetailsParams.extend({
    modelFileId: z.number(),
    loraName: z.string(),
  }),
});
