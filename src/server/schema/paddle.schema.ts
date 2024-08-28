import { CurrencyCode } from '@paddle/paddle-js';
import { z } from 'zod';
import { constants } from '~/server/common/constants';

const buzzPurchaseMetadataSchema = z
  .object({
    type: z.enum(['buzzPurchase']),
    buzzAmount: z.coerce.number().positive(),
    unitAmount: z.coerce.number().positive(),
    userId: z.coerce.number().positive(),
    buzzTransactionId: z.string().optional(),
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
