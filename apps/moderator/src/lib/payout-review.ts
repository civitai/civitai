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
