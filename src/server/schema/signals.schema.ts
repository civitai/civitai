import { TrainingStatus } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { buzzAccountTypes } from '~/server/schema/buzz.schema';
import { modelFileMetadataSchema } from '~/server/schema/model-file.schema';

export type GetSignalsAccessTokenResponse = z.infer<typeof getSignalsAccessTokenResponse>;
export const getSignalsAccessTokenResponse = z.object({
  accessToken: z.string(),
});

export type BuzzUpdateSignalSchema = z.infer<typeof buzzUpdateSignalSchema>;
export const buzzUpdateSignalSchema = z.object({
  balance: z.number(),
  delta: z.number(),
  deltaSince: z.date().optional(),
  accountType: z.enum(buzzAccountTypes),
});

export type TrainingUpdateSignalSchema = z.infer<typeof trainingUpdateSignalSchema>;
export const trainingUpdateSignalSchema = z.object({
  modelId: z.number(),
  modelVersionId: z.number(),
  status: z.enum(TrainingStatus),
  fileMetadata: modelFileMetadataSchema,
});
