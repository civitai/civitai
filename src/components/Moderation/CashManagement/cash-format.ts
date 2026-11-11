import { TransactionType } from '~/shared/constants/buzz.constants';

export type CashAccountType = 'cashPending' | 'cashSettled';
export type CashAdjustmentDirection = 'grant' | 'deduct';

export function centsToDollars(cents: number) {
  return (cents / 100).toFixed(2);
}

export function dollars(cents: number) {
  return `${cents < 0 ? '−' : ''}$${centsToDollars(Math.abs(cents))}`;
}

export function signedDollars(cents: number) {
  return `${cents < 0 ? '−' : '+'}$${centsToDollars(Math.abs(cents))}`;
}

// The buzz service signs amounts relative to the account being read, and a mod deduct is recorded
// as a Withdrawal, the same type a payout uses — so the sign and the description decide, not type.
export function describeCashTransaction(t: {
  amount: number;
  type: TransactionType;
  description?: string | null;
}) {
  const kind = t.amount < 0 ? 'Debit' : t.type === TransactionType.Refund ? 'Return' : 'Credit';
  const label = t.description?.startsWith('Mod cash adjustment')
    ? 'Mod adjustment'
    : TransactionType[t.type] ?? 'Unknown';
  return { kind, label } as const;
}
