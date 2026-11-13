export type GetPaidCard = 'bank' | 'extract' | 'estimatedEarnings' | 'withdraw';

/** A lapsed member still sees estimated earnings and withdraw: the monthly payout does not check membership. */
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
