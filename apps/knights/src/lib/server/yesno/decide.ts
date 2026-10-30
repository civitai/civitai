export type YesNoDecision =
  | { kind: 'pending' }
  | { kind: 'consensus'; value: 'yes' | 'no' }
  | { kind: 'exhausted' };

/**
 * One vote per person, as the label store counts them. Enough answers and a strict majority is a consensus; a tie is no
 * outcome, so the question keeps being asked until it is broken or `max` answers are in.
 */
export function decideYesNo(
  votes: { answer: string }[],
  rule: { needed: number; max: number }
): YesNoDecision {
  const yes = votes.filter((v) => v.answer === 'yes').length;
  const no = votes.filter((v) => v.answer === 'no').length;
  const total = yes + no;
  if (total >= rule.needed && yes !== no)
    return { kind: 'consensus', value: yes > no ? 'yes' : 'no' };
  return total >= rule.max ? { kind: 'exhausted' } : { kind: 'pending' };
}
