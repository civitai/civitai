import { z } from 'zod';
import {
  MIN_BANK_AMOUNT,
  MIN_WITHDRAWAL_AMOUNT,
} from '~/shared/constants/creator-program.constants';

export const bankBuzzSchema = z.object({
  amount: z.number().min(MIN_BANK_AMOUNT),
});

export const withdrawCashSchema = z.object({
  amount: z.number().min(MIN_WITHDRAWAL_AMOUNT),
});
