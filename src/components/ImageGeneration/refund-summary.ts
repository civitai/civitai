import type { TransactionInfo } from '@civitai/orchestration-client';

export type RefundSummary = {
  state: 'refunded' | 'partial';
  /** Total credited back. */
  amount: number;
  /** Total originally charged. */
  charged: number;
  /** Friendly Buzz label, e.g. "Green Buzz". Plain "Buzz" when mixed or yellow. */
  label: string;
  /** Badge text, e.g. "Refunded 108 Green Buzz". */
  text: string;
};

const accountLabel: Partial<Record<TransactionInfo['accountType'], string>> = {
  blue: 'Blue',
  green: 'Green',
};

const failedStatuses = ['failed', 'expired', 'canceled'];

/**
 * Reads the refund off the workflow's own transactions: the orchestrator records
 * a refund as a `credit` entry (its id is a plain uuid, so key on type only).
 * Returns null unless the workflow ended unsuccessfully AND something was credited back.
 */
export function getRefundSummary(
  status: string | null | undefined,
  transactions: TransactionInfo[] | null | undefined
): RefundSummary | null {
  if (!status || !failedStatuses.includes(status)) return null;
  const list = transactions ?? [];
  const credits = list.filter((t) => t.type === 'credit' && t.amount > 0);
  if (!credits.length) return null;

  const amount = credits.reduce((acc, t) => acc + t.amount, 0);
  const charged = list.filter((t) => t.type === 'debit').reduce((acc, t) => acc + t.amount, 0);
  const accounts = Array.from(new Set(credits.map((t) => t.accountType)));
  const prefix = accounts.length === 1 ? accountLabel[accounts[0]] : undefined;
  const label = prefix ? `${prefix} Buzz` : 'Buzz';
  const partial = amount < charged;

  return {
    state: partial ? 'partial' : 'refunded',
    amount,
    charged,
    label,
    text: partial
      ? `Refunded ${amount.toLocaleString()} of ${charged.toLocaleString()} ${label}`
      : `Refunded ${amount.toLocaleString()} ${label}`,
  };
}
