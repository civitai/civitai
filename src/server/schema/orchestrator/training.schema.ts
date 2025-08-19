import type { SessionUser } from 'next-auth';
import * as z from 'zod';
import { OrchEngineTypes, OrchPriorityTypes } from '~/server/common/enums';
import { trainingDetailsParams } from '~/server/schema/model-version.schema';

const imageTrainingBaseSchema = z.object({
  model: z.string(),
  priority: z.enum(OrchPriorityTypes), // technically can be a number
  engine: z.enum(OrchEngineTypes),
  trainingDataImagesCount: z.number(),
});

const whatIfTrainingDetailsParams = trainingDetailsParams.pick({
  resolution: true,
  maxTrainEpochs: true,
  numRepeats: true,
  trainBatchSize: true,
});

export const imageTrainingRouterWhatIfSchema = imageTrainingBaseSchema.merge(
  whatIfTrainingDetailsParams
);
export type ImageTrainingRouterWhatIfSchema = z.infer<typeof imageTrainingRouterWhatIfSchema>;

const imageTrainingStepSchema = imageTrainingBaseSchema.extend({
  trainingData: z.url(),
  loraName: z.string(),
  samplePrompts: z.array(z.string()),
  params: z.union([
    trainingDetailsParams.extend({ engine: z.enum(OrchEngineTypes) }),
    whatIfTrainingDetailsParams.extend({ engine: z.enum(OrchEngineTypes) }),
  ]),
  modelFileId: z.number(),
});
export type ImageTrainingStepSchema = z.infer<typeof imageTrainingStepSchema>;

export const imageTrainingRouterInputSchema = z.object({
  modelVersionId: z.number(),
});

const imageTrainingWorkflowSchema = imageTrainingRouterInputSchema.extend({
  token: z.string(),
});
export type ImageTrainingWorkflowSchema = z.infer<typeof imageTrainingWorkflowSchema> & {
  user: SessionUser;
};

const imageTraininWhatIfgWorkflowSchema = imageTrainingRouterWhatIfSchema.extend({
  token: z.string(),
});
export type ImageTraininWhatIfWorkflowSchema = z.infer<typeof imageTraininWhatIfgWorkflowSchema>;
