import * as z from 'zod';

export type DepositHistoryInput = z.infer<typeof depositHistoryInputSchema>;
export const depositHistoryInputSchema = z.object({
  page: z.number().int().min(1).default(1),
  perPage: z.number().int().min(1).max(25).default(3),
});

export type GetDepositAddressInput = z.infer<typeof getDepositAddressInputSchema>;
export const getDepositAddressInputSchema = z.object({
  chain: z.enum(['evm', 'sol', 'trx', 'btc', 'doge', 'ltc']).default('evm'),
});

export type GetMinAmountInput = z.infer<typeof getMinAmountInputSchema>;
export const getMinAmountInputSchema = z.object({
  currencyCode: z.string().min(1).max(20),
  fiat: z.string().min(1).max(10).default('usd'),
});

export type GetBuzzConversionRateInput = z.infer<typeof getBuzzConversionRateInputSchema>;
export const getBuzzConversionRateInputSchema = z.object({
  fiat: z.string().min(1).max(10).default('usd'),
});
