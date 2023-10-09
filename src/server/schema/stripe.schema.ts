import { z } from 'zod';
import { Currency } from '@prisma/client';
import { constants } from '~/server/common/constants';

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
  priceId: z.string(),
  returnUrl: z.string(),
  customAmount: z.number().min(constants.buzz.minChargeAmount).optional(),
});

export type BuzzPriceMetadata = z.infer<typeof buzzPriceMetadataSchema>;
export const buzzPriceMetadataSchema = z.object({
  buzzAmount: z.coerce.number().positive().optional(),
  bonusDescription: z.coerce.string().optional(),
});

const buzzPurchaseMetadataSchema = z
  .object({
    type: z.literal('buzzPurchase'),
    buzzAmount: z.coerce.number().positive(),
    unitAmount: z.coerce.number().positive(),
    userId: z.coerce.number().positive(),
    transactionId: z.string().optional(),
  })
  .passthrough();

export type PaymentIntentMetadataSchema = z.infer<typeof paymentIntentMetadataSchema>;

export const paymentIntentMetadataSchema = z.discriminatedUnion('type', [
  buzzPurchaseMetadataSchema,
]);

export type PaymentIntentCreationSchema = z.infer<typeof paymentIntentCreationSchema>;
export const paymentIntentCreationSchema = z.object({
  unitAmount: z.number().min(constants.buzz.minChargeAmount).max(constants.buzz.maxChargeAmount),
  currency: z.nativeEnum(Currency),
  metadata: paymentIntentMetadataSchema,
  paymentMethodTypes: z.array(z.string()).nullish(),
});
