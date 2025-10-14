import * as z from 'zod';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { booleanString } from '~/utils/zod-helpers';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

export type GetPlansSchema = z.infer<typeof getPlansSchema>;
export const getPlansSchema = z.object({
  paymentProvider: z.enum(PaymentProvider).optional(),
  interval: z.enum(['month', 'year']).optional(),
  buzzType: z.string().optional(),
});

export type GetUserSubscriptionInput = z.infer<typeof getUserSubscriptionSchema>;
export const getUserSubscriptionSchema = z.object({
  userId: z.number(),
  buzzType: z.string().optional(),
});

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
    buzzType: z.enum(['green', 'yellow', 'blue', 'red']).default('yellow').optional(),

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
    prepaids: z
      .partialRecord(z.enum(['free', 'founder', 'bronze', 'silver', 'gold']), z.number())
      .optional(),
    proratedDays: z
      .partialRecord(z.enum(['free', 'founder', 'bronze', 'silver', 'gold']), z.number())
      .optional(),
  })
  .passthrough();
