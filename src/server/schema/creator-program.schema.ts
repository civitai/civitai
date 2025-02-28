import { z } from 'zod';
import {
  MIN_BANK_AMOUNT,
  MIN_WITHDRAWAL_AMOUNT,
} from '~/shared/constants/creator-program.constants';
import { CashWithdrawalStatus } from '~/shared/utils/prisma/enums';

export type BankBuzzInput = z.infer<typeof bankBuzzSchema>;
export const bankBuzzSchema = z.object({
  amount: z.number().min(MIN_BANK_AMOUNT),
});

export type WithdrawCashInput = z.infer<typeof withdrawCashSchema>;
export const withdrawCashSchema = z.object({
  amount: z.number().min(MIN_WITHDRAWAL_AMOUNT),
});

export type CashWithdrawalMetadataSchema = z.infer<typeof cashWithdrawalMetadataSchema>;
export const cashWithdrawalMetadataSchema = z
  .object({
    paymentBatchId: z.string().optional(),
    paymentRefCode: z.string().optional(),
    paidAmount: z.number().optional(),
  })
  .passthrough();

export type UpdateCashWithdrawalSchema = z.infer<typeof updateCashWithdrawalSchema>;
export const updateCashWithdrawalSchema = z.object({
  withdrawalId: z.string(),
  status: z.nativeEnum(CashWithdrawalStatus),
  note: z.string().optional(),
  metadata: cashWithdrawalMetadataSchema.optional(),
  fees: z.number().optional(),
});

export type CompensationPoolInput = z.infer<typeof compensationPoolInputSchema>;
export const compensationPoolInputSchema = z.object({
  month: z.date().optional(),
});
