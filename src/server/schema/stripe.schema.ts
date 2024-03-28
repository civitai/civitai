import { z } from 'zod';
import { Currency } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { booleanString } from '~/utils/zod-helpers';

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
    type: z.enum(['buzzPurchase', 'clubMembershipPayment']),
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
  recaptchaToken: z.string(),
});

export type GetPaymentIntentsForBuzzSchema = z.infer<typeof getPaymentIntentsForBuzzSchema>;
export const getPaymentIntentsForBuzzSchema = z.object({
  userId: z.coerce.number().optional(),
  startingAt: z.coerce.date().min(constants.buzz.cutoffDate).optional(),
  endingAt: z.coerce.date().min(constants.buzz.cutoffDate).optional(),
});

export type SetupIntentCreateSchema = z.infer<typeof setupIntentCreateSchema>;
export const setupIntentCreateSchema = z.object({
  paymentMethodTypes: z.array(z.string()).nullish(),
});

export type PaymentMethodDeleteInput = z.infer<typeof paymentMethodDeleteInput>;
export const paymentMethodDeleteInput = z.object({
  paymentMethodId: z.string(),
});

export type ProductMetadata = z.infer<typeof productMetadataSchema>;
export const productMetadataSchema = z
  .object({
    vaultSizeKb: z.coerce.number().positive().optional(),
    badge: z.string().optional(),
    monthlyBuzz: z.coerce.number().positive().optional(),
    animatedBadge: booleanString().optional(),
    badgeType: z.enum(['none', 'static', 'animated']),
    tier: z.enum(['founder', 'bronze', 'silver', 'gold']),
    generationLimit: z.coerce.number().positive().optional(),
    quantityLimit: z.coerce.number().positive().optional(),
    queueLimit: z.coerce.number().positive().optional(),
    rewardsMultiplier: z.coerce.number().positive().default(1),
    purchasesMultiplier: z.coerce.number().positive().default(1),
  })
  .passthrough();
