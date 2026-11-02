/** The rulings a moderator can record on an award left neither paid nor refunded. */
export const BOUNTY_AWARD_RULINGS = [
  'paid_winner',
  'refunded_supporter',
  'no_charge_found',
] as const;
export type BountyAwardRuling = (typeof BOUNTY_AWARD_RULINGS)[number];
