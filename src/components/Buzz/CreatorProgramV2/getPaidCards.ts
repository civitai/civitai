export type GetPaidCard = 'bank' | 'extract' | 'estimatedEarnings' | 'withdraw';

/**
 * The "Get Paid" cards an onboarded creator sees beside the membership-lapsed notice. A lapsed
 * member keeps seeing what they banked: the monthly payout does not check membership.
 */
export function getPaidCards({
  phase,
  membershipLapsed,
}: {
  phase?: string;
  membershipLapsed: boolean;
}): GetPaidCard[] {
  const cards: GetPaidCard[] = [];
  if (phase === 'bank' && !membershipLapsed) cards.push('bank');
  if (phase === 'extraction') cards.push('extract');
  cards.push('estimatedEarnings', 'withdraw');
  return cards;
}
