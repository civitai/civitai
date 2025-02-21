import { UserTier } from '~/server/schema/user.schema';
import { CashWithdrawalMethod } from '~/shared/utils/prisma/enums';

export const EXTRACTION_PHASE_DURATION = 3; // days

type ExtractionFee = {
  min: number;
  max: number;
  fee: number;
};
export const EXTRACTION_FEES: ExtractionFee[] = [
  {
    min: 0,
    max: 100000,
    fee: 0,
  },
  {
    min: 100000,
    max: 1000000,
    fee: 0.05,
  },
  {
    min: 1000000,
    max: 5000000,
    fee: 0.1,
  },
  {
    min: 5000000,
    max: Infinity,
    fee: 0.15,
  },
];

export type CapDefinition = {
  tier: UserTier;
  limit?: number;
  percentOfPeakEarning?: number;
};
export const PEAK_EARNING_WINDOW = 12;
export const MIN_CAP = 100000;
export const CAP_DEFINITIONS: CapDefinition[] = [
  { tier: 'bronze', limit: MIN_CAP },
  { tier: 'founder', limit: MIN_CAP },
  { tier: 'silver', limit: 1000000, percentOfPeakEarning: 1.25 },
  { tier: 'gold', percentOfPeakEarning: 1.5 },
];

export const MIN_BANK_AMOUNT = 10000;
export const MIN_WITHDRAWAL_AMOUNT = 5000;
export const MIN_CREATOR_SCORE = 100000;

type WithdrawalFee = {
  type: 'fixed' | 'percent';
  amount: number;
};

// TODO creators program - Justin: Revise withdrawal fees here. They might make no sense.
export const WITHDRAWAL_FEES: Record<CashWithdrawalMethod, WithdrawalFee | undefined> = {
  ACH: { type: 'fixed', amount: 200 },
  PayPal: { type: 'percent', amount: 0.05 },
  Check: { type: 'fixed', amount: 400 },
  Card: { type: 'fixed', amount: 200 },
  Custom: { type: 'fixed', amount: 200 },
  ECheck: { type: 'fixed', amount: 200 },
  Intercash: { type: 'fixed', amount: 200 },
  Payoneer: { type: 'fixed', amount: 200 },
  WireTransfer: { type: 'fixed', amount: 200 },
  HoldPayments: undefined,
  NotProvided: undefined,
  TipaltiInternalValue: undefined,
};

export const FIRST_CREATOR_PROGRAM_MONTH = new Date('2025-03-01');
export const CAPPED_BUZZ_VALUE = (1 / 1000) * 100; // $0.001 per Buzz (*100 to convert to cents)
