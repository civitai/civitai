import { TrainingStatus } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { buzzAccountTypes } from '~/shared/constants/buzz.constants';
import { modelFileMetadataSchema } from '~/server/schema/model-file.schema';

export type GetSignalsAccessTokenResponse = z.infer<typeof getSignalsAccessTokenResponse>;
export const getSignalsAccessTokenResponse = z.object({
  // Optional so signals.getToken can fail SOFT: a transient signals-service
  // blip (Orleans crashloop / connection reset / timeout / open circuit)
  // returns `{ accessToken: undefined }` instead of a hard 500. The client
  // (useSignalsWorker) reads `data?.accessToken` and only opens the SignalR
  // connection when it's present, so a missing token degrades to no-live-updates
  // (until the tab remounts — it does not auto-recover; see SIGNALS_UNAVAILABLE
  // in signals.service.ts) — never a thrown request.
  accessToken: z.string().optional(),
});

export type BuzzUpdateSignalSchema = z.infer<typeof buzzUpdateSignalSchema>;
export const buzzUpdateSignalSchema = z.object({
  balance: z.number(),
  delta: z.number(),
  deltaSince: z.date().optional(),
  accountType: z.string(),
});

export type TrainingUpdateSignalSchema = z.infer<typeof trainingUpdateSignalSchema>;
export const trainingUpdateSignalSchema = z.object({
  modelId: z.number(),
  modelVersionId: z.number(),
  status: z.enum(TrainingStatus),
  fileMetadata: modelFileMetadataSchema,
});
