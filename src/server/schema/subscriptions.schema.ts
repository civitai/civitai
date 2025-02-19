import { z } from 'zod';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { booleanString } from '~/utils/zod-helpers';

export type GetPlansSchema = z.infer<typeof getPlansSchema>;
export const getPlansSchema = z.object({
  paymentProvider: z.nativeEnum(PaymentProvider).optional(),
});

export type GetUserSubscriptionInput = z.infer<typeof getUserSubscriptionSchema>;
export const getUserSubscriptionSchema = z.object({ userId: z.number() });

export type SubscriptionProductMetadata = z.infer<typeof subscriptionProductMetadataSchema>;
export const subscriptionProductMetadataSchema = z
  .object({
    vaultSizeKb: z.coerce.number().positive().optional(),
    badge: z.string().optional(),
    monthlyBuzz: z.coerce.number().positive().optional(),
    animatedBadge: booleanString().optional(),
    badgeType: z.enum(['none', 'static', 'animated']).default('none'),
    tier: z.enum(['free', 'founder', 'bronze', 'silver', 'gold']),
    generationLimit: z.coerce.number().positive().optional(),
    quantityLimit: z.coerce.number().positive().optional(),
    queueLimit: z.coerce.number().positive().optional(),
    rewardsMultiplier: z.coerce.number().positive().default(1),
    purchasesMultiplier: z.coerce.number().positive().default(1),

    // Makes it so that we include it when creating a paddle transaction.
    // Used for Save Details only.
    includeWithTransaction: booleanString().optional(),
    maxPrivateModels: z.coerce.number().positive().optional(),
    supportLevel: z.string().optional(),
  })
  .passthrough();

export type SubscriptionMetadata = z.infer<typeof subscriptionMetadata>;

export const subscriptionMetadata = z
  .object({
    renewalEmailSent: z.boolean().optional(),
    renewalBonus: z.number().optional(),
  })
  .passthrough();
