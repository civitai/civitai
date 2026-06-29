import { z } from 'zod';

export const merchOrderIdSchema = z.object({
  shopifyOrderId: z.string().trim().min(1).max(64),
});
export type MerchOrderIdInput = z.infer<typeof merchOrderIdSchema>;

export const requestMerchClaimConfirmationSchema = merchOrderIdSchema.extend({
  email: z.string().trim().email(),
});
export type RequestMerchClaimConfirmationInput = z.infer<
  typeof requestMerchClaimConfirmationSchema
>;

export const confirmMerchClaimSchema = z.object({
  token: z.string().min(1),
});
export type ConfirmMerchClaimInput = z.infer<typeof confirmMerchClaimSchema>;
