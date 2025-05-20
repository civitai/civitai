import { z } from 'zod';
import { constants } from '~/server/common/constants';

export type TransactionCreateInput = z.infer<typeof transactionCreateSchema>;
export const transactionCreateSchema = z.object({
  unitAmount: z.number().min(constants.buzz.minChargeAmount).max(constants.buzz.maxChargeAmount),
  currency: z.string(),
  usdAmount: z.number(),
  recaptchaToken: z.string(),
});

export type PriceEstimateInput = z.infer<typeof priceEstimateInputSchema>;
export const priceEstimateInputSchema = z.object({
  amount: z.number(),
  currencyTo: z.string().optional(),
});
