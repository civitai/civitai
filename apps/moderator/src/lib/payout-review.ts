/** The pre-payout review's decisions, as `POST /api/admin/creator-program-payout-review` takes them. */
export const PAYOUT_REVIEW_ACTIONS = ['clear', 'escalate', 'withhold'] as const;
export type PayoutReviewAction = (typeof PAYOUT_REVIEW_ACTIONS)[number];

// A copy of TRANSITIONS in src/server/services/creator-program-prepayout-review/hold.ts, used only to
// pick which buttons a row shows. That endpoint decides: anything it does not allow comes back 409.
const ALLOWED_FROM: Record<PayoutReviewAction, readonly string[]> = {
  escalate: ['open', 'cleared'],
  withhold: ['open', 'escalated', 'cleared'],
  clear: ['open', 'escalated', 'withheld'],
};

export const STALE_REVIEW =
  'This review changed since you loaded it. Reload the page and decide again.';
export const UNCONFIRMED_DECISION =
  'No answer from the main app: the decision may have been recorded. Reload before deciding again.';

export const allowedActions = (status: string): PayoutReviewAction[] =>
  PAYOUT_REVIEW_ACTIONS.filter((action) => ALLOWED_FROM[action].includes(status));

export type SettlementRow = { userId: number; period: string; status: string; hold: boolean };

/** `resolveHolds` in src/server/services/creator-program-prepayout-review/hold.ts, which settlement
 *  reads; pinned by that directory's spoke-settlement-parity test. An open or escalated review holds
 *  in any period while `hold` is set, but a withhold or a clear counts only on the latest period. */
export function settlementState(rows: SettlementRow[]) {
  const latest = new Map<number, string>();
  for (const r of rows) {
    const seen = latest.get(r.userId);
    if (!seen || r.period > seen) latest.set(r.userId, r.period);
  }
  const isLatest = (r: SettlementRow) => latest.get(r.userId) === r.period;
  const holds = (r: SettlementRow) =>
    (r.hold && (r.status === 'open' || r.status === 'escalated')) ||
    (r.status === 'withheld' && isLatest(r));
  const heldUserIds = new Set(rows.filter(holds).map((r) => r.userId));
  return { latest, isLatest, holds, heldUserIds };
}
