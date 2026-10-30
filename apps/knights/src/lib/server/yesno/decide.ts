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

/**
 * The consensus size and the cap, read live from the axis question so tuning its row takes effect. A cap below the consensus size
 * could never be reached before a consensus is possible, so it is treated as the consensus size.
 */
export function consensusRule(
  question: { votesToResolve: number; maxVotes: number },
  warn: (message: string) => void = (message) => console.warn(message)
): { needed: number; max: number } {
  const needed = Math.max(1, question.votesToResolve);
  if (question.maxVotes < needed) {
    warn(
      `knights: a yes/no question allows ${question.maxVotes} answers but needs ${needed}; using ${needed}`
    );
    return { needed, max: needed };
  }
  return { needed, max: question.maxVotes };
}
