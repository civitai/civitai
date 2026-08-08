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
};

export type BuzzHistory = {
  transactions: BuzzTransaction[];
  /** The window the server actually queried — 1.5B rows means this is always bounded, and the panel has
   *  to say so rather than implying it shows everything. */
  days: number;
  truncated: boolean;
};

export async function fetchBuzzHistory(userId: number): Promise<BuzzHistory> {
  const r = await fetch(`/api/user-buzz-history/${userId}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
