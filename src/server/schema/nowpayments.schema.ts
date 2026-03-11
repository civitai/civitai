import * as z from 'zod';

export type DepositHistoryInput = z.infer<typeof depositHistoryInputSchema>;
export const depositHistoryInputSchema = z.object({
  page: z.number().default(1),
  perPage: z.number().default(3),
});

export type GetMinAmountInput = z.infer<typeof getMinAmountInputSchema>;
export const getMinAmountInputSchema = z.object({
  currencyCode: z.string(),
  fiat: z.string().default('usd'),
});

export type GetBuzzConversionRateInput = z.infer<typeof getBuzzConversionRateInputSchema>;
export const getBuzzConversionRateInputSchema = z.object({
  fiat: z.string().default('usd'),
});
