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
  // Match credits to debits per account, so a refund never exceeds what that
  // account was charged and the label/denominator describe the same Buzz.
  const sumBy = (type: TransactionInfo['type']) => {
    const m = new Map<TransactionInfo['accountType'], number>();
    for (const t of list)
      if (t.type === type) m.set(t.accountType, (m.get(t.accountType) ?? 0) + t.amount);
    return m;
  };
  const debits = sumBy('debit');
  const credits = sumBy('credit');
  let amount = 0;
  let charged = 0;
  for (const [account, debited] of debits) {
    charged += debited;
    amount += Math.min(debited, credits.get(account) ?? 0);
  }
  if (amount <= 0) return null;

  const accounts = Array.from(debits.keys());
  const prefix = accounts.length === 1 ? accountLabel[accounts[0]] : undefined;
  const label = prefix ? `${prefix} Buzz` : 'Buzz';
  const partial = amount < charged;

  return {
    state: partial ? 'partial' : 'refunded',
    amount,
    charged,
    label,
    text: partial
      ? `Refunded ${amount.toLocaleString('en-US')} of ${charged.toLocaleString('en-US')} ${label}`
      : `Refunded ${amount.toLocaleString('en-US')} ${label}`,
  };
}
