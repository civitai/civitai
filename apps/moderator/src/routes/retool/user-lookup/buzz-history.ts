// The `/api/user-buzz-history` payload. Page-local for the same reason as its siblings: it crosses a
// JSON boundary, so `Date` arrives as `string`.

export type BuzzTransaction = {
  transactionId: string;
  date: string;
  direction: 'in' | 'out';
  amount: number;
  color: string;
  type: string;
  description: string;
  counterpartyId: number;
  counterpartyName: string | null;
  /** Set instead of a name when the counterparty is not a user account (Civitai itself, the Creator
   *  Program bank, …) — those ids collide with real user ids and must never be linked. */
  counterpartyLabel: string | null;
  externalTransactionId: string | null;
};

export type BuzzHistory = {
  /** Retool's split: payments are money OUT of this account, receipts money IN. */
  payments: BuzzTransaction[];
  receipts: BuzzTransaction[];
  /** The window the server actually queried — 1.5B rows means this is always bounded, and the panel has
   *  to say so rather than implying it shows everything. */
  days: number;
  /** The per-side cap the server actually applied — clamped, so it can be lower than what was asked
   *  for. The panel states this rather than its own request value. */
  limit: number;
  /** Per side: the two are capped independently, and a busy receipts column says nothing about whether
   *  the payments column is complete. */
  truncated: { payments: boolean; receipts: boolean };
};

export async function fetchBuzzHistory(
  userId: number,
  days: number,
  limit: number
): Promise<BuzzHistory> {
  const r = await fetch(`/api/user-buzz-history/${userId}?days=${days}&limit=${limit}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** The distinct `type` values present, for the per-table filter. Retool's dropdowns were built the
 *  same way — from the loaded rows, not a fixed list. */
export const typesIn = (rows: BuzzTransaction[]): string[] =>
  [...new Set(rows.map((t) => t.type))].sort();

export function filterTransactions(
  rows: BuzzTransaction[],
  type: string,
  description: string
): BuzzTransaction[] {
  const needle = description.trim().toLowerCase();
  return rows.filter(
    (t) =>
      (type === 'all' || t.type === type) &&
      (!needle || (t.description ?? '').toLowerCase().includes(needle))
  );
}
