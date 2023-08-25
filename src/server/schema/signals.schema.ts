import { z } from 'zod';

export type GetSignalsAccessTokenResponse = z.infer<typeof getSignalsAccessTokenResponse>;
export const getSignalsAccessTokenResponse = z.object({
  accessToken: z.string(),
});

export type BuzzUpdateSignalSchema = z.infer<typeof buzzUpdateSignalSchema>;

export const buzzUpdateSignalSchema = z.object({
  balance: z.number(),
  delta: z.number(),
  deltaSince: z.date().optional(),
});
