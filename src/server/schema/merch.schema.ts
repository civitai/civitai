import { z } from 'zod';

export const claimMerchByKeySchema = z.object({
  key: z.string().min(1),
});
export type ClaimMerchByKeyInput = z.infer<typeof claimMerchByKeySchema>;
