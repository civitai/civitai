import { z } from 'zod';
import { Currency, PaymentProvider } from '@prisma/client';
import { constants } from '~/server/common/constants';
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
    badgeType: z.enum(['none', 'static', 'animated']),
    tier: z.enum(['founder', 'bronze', 'silver', 'gold']),
    generationLimit: z.coerce.number().positive().optional(),
    quantityLimit: z.coerce.number().positive().optional(),
    queueLimit: z.coerce.number().positive().optional(),
    rewardsMultiplier: z.coerce.number().positive().default(1),
    purchasesMultiplier: z.coerce.number().positive().default(1),
  })
  .passthrough();