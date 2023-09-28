import { z } from 'zod';

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export const createCustomerSchema = z.object({ id: z.number(), email: z.string().email() });

export type CreateSubscribeSessionInput = z.infer<typeof createSubscribeSessionSchema>;
export const createSubscribeSessionSchema = z.object({ priceId: z.string() });

export type GetUserSubscriptionInput = z.infer<typeof getUserSubscriptionSchema>;
export const getUserSubscriptionSchema = z.object({ userId: z.number() });

export type CreateDonateSessionInput = z.infer<typeof createDonateSessionSchema>;
export const createDonateSessionSchema = z.object({ returnUrl: z.string() });

export type CreateBuzzSessionInput = z.infer<typeof createBuzzSessionSchema>;
export const createBuzzSessionSchema = z.object({
  returnUrl: z.string(),
  priceId: z.string().optional(),
  productId: z.string().optional(),
  customAmount: z.number().min(5).optional(),
});

export type BuzzPriceMetadata = z.infer<typeof buzzPriceMetadataSchema>;
export const buzzPriceMetadataSchema = z.object({
  buzzAmount: z.coerce.number().positive(),
  bonusDescription: z.coerce.string().optional(),
});
