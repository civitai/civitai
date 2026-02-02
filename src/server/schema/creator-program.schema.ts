import * as z from 'zod';
import { preprocessAccountType } from '~/server/schema/buzz.schema';
import { buzzBankTypes } from '~/shared/constants/buzz.constants';
import {
  MIN_BANK_AMOUNT,
  MIN_WITHDRAWAL_AMOUNT,
} from '~/shared/constants/creator-program.constants';
import { CashWithdrawalStatus } from '~/shared/utils/prisma/enums';

export type BankBuzzInput = z.infer<typeof bankBuzzSchema>;
export const bankBuzzSchema = z.object({
  amount: z.number().min(MIN_BANK_AMOUNT),
  accountType: z.preprocess(preprocessAccountType, z.enum(buzzBankTypes).default('yellow')),
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
  status: z.enum(CashWithdrawalStatus),
  note: z.string().optional(),
  metadata: cashWithdrawalMetadataSchema.optional(),
  fees: z.number().optional(),
});

export type CompensationPoolInput = z.infer<typeof compensationPoolInputSchema>;
export const compensationPoolInputSchema = z.object({
  month: z.date().optional(),
  buzzType: z.preprocess(preprocessAccountType, z.enum(buzzBankTypes).optional()),
});

export type ModCashAdjustmentInput = z.infer<typeof modCashAdjustmentSchema>;
export const modCashAdjustmentSchema = z.object({
  userId: z.number().int().positive(),
  amount: z.number().int().positive().max(10_000_000, 'Amount cannot exceed $100,000'),
  accountType: z.enum(['cashPending', 'cashSettled']),
  direction: z.enum(['grant', 'deduct']),
  note: z.string().min(1, 'A reason/note is required'),
});
