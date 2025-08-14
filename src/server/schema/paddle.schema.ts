import type { CurrencyCode } from '@paddle/paddle-js';
import * as z from 'zod';
import { constants } from '~/server/common/constants';

const buzzPurchaseMetadataSchema = z
  .object({
    type: z.enum(['buzzPurchase']),
    buzzAmount: z.coerce.number().positive(),
    unitAmount: z.coerce.number().positive(),
    userId: z.coerce.number().positive(),
    buzzTransactionId: z.string().optional(),
    // For whatever reason, paddle converts it to snake case.
    buzz_amount: z.coerce.number().positive().optional(),
    user_id: z.coerce.number().positive().optional(),
  })
  .passthrough();

export type TransactionMetadataSchema = z.infer<typeof transactionMetadataSchema>;

export const transactionMetadataSchema = z.discriminatedUnion('type', [buzzPurchaseMetadataSchema]);

export type TransactionCreateInput = z.infer<typeof transactionCreateSchema>;
export const transactionCreateSchema = z.object({
  unitAmount: z.number().min(constants.buzz.minChargeAmount).max(constants.buzz.maxChargeAmount),
  currency: z
    .string()
    .default('USD')
    .refine((val) => val as CurrencyCode, { message: 'Only USD is supported' }),
  metadata: transactionMetadataSchema.optional(),
  recaptchaToken: z.string(),
});

export type TransactionWithSubscriptionCreateInput = z.infer<
  typeof transactionWithSubscriptionCreateSchema
>;
export const transactionWithSubscriptionCreateSchema = transactionCreateSchema.omit({
  recaptchaToken: true,
});

export type UpdateSubscriptionInputSchema = z.infer<typeof updateSubscriptionInputSchema>;
export const updateSubscriptionInputSchema = z.object({
  priceId: z.string(),
});

export const AdjustmentAction = [
  'credit',
  'credit_reverse',
  'refund',
  'chargeback',
  'chargeback_reverse',
  'chargeback_warning',
] as const;

export type GetPaddleAdjustmentsSchema = z.infer<typeof getPaddleAdjustmentsSchema>;
export const getPaddleAdjustmentsSchema = z.object({
  limit: z.number().optional().default(50),
  cursor: z.string().optional(),
  customerId: z.array(z.string()).optional(),
  subscriptionId: z.array(z.string()).optional(),
  transactionId: z.array(z.string()).optional(),
  action: z.enum(AdjustmentAction).optional(),
});
