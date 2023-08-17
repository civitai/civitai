import { z } from 'zod';

export type GetSignalsAccessTokenResponse = z.infer<typeof getSignalsAccessTokenResponse>;
export const getSignalsAccessTokenResponse = z.object({
  accessToken: z.string(),
});
