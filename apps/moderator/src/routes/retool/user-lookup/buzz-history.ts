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

export type BuzzLedgerSide = {
  rows: BuzzTransaction[];
  /** The window the server actually queried — 1.5B rows means this is always bounded, and the panel has
   *  to say so rather than implying it shows everything. */
  days: number;
  /** The cap the server actually applied — clamped, so it can be lower than what was asked for. The
   *  panel states this rather than its own request value. */
  limit: number;
  truncated: boolean;
  /** Every type on this side across the whole window, for the filter. Not derived from the rows: a type
   *  the cap pushed off the page must still be selectable, since selecting it is what fetches it. */
  types: string[];
};

/**
 * One side per request. The two columns filter independently, so a shared request made each of them
 * reload the other — and blank it meanwhile — for an answer that had not changed.
 */
export async function fetchBuzzLedgerSide(
  userId: number,
  side: 'payments' | 'receipts',
  days: number,
  limit: number,
  type: string
): Promise<BuzzLedgerSide> {
  const params = new URLSearchParams({ side, days: String(days), limit: String(limit), type });
  const r = await fetch(`/api/user-buzz-history/${userId}?${params}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/**
 * Description only. The TYPE filter is the server's — narrowing here could only ever shrink the page
 * already fetched, which is what made a purchase behind thousands of rewards unreachable at any window.
 */
export function filterTransactions(
  rows: BuzzTransaction[],
  description: string
): BuzzTransaction[] {
  const needle = description.trim().toLowerCase();
  return needle ? rows.filter((t) => (t.description ?? '').toLowerCase().includes(needle)) : rows;
}
