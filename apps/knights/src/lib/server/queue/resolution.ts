import { RANK_WEIGHT, type Rank } from './ranks';

const BASE_XP_FOR_NEXT_LEVEL = 250;
const XP_GROWTH_RATE = 1.18;

export function levelForExp(totalXp: number): number {
  let level = 1;
  let xpForNextLevel = BASE_XP_FOR_NEXT_LEVEL;
  let remaining = totalXp;
  while (remaining >= xpForNextLevel) {
    remaining -= xpForNextLevel;
    level++;
    xpForNextLevel = Math.floor(xpForNextLevel * XP_GROWTH_RATE);
  }
  return level;
}

export function voteWeight({
  rank,
  level,
  smites,
}: {
  rank: Rank;
  level: number;
  smites: number;
}): number {
  if (rank === 'Inquisitor') return 0;
  const base = RANK_WEIGHT[rank];
  if (base === 0) return 0;
  const weight = base + (level - 20) / 60 - smites / 6;
  return Math.max(0, Math.round(weight * 100) / 100);
}

export type WeightedAnswer = { answer: string; weight: number };

export type Decision =
  | { kind: 'pending' }
  | { kind: 'resolved'; value: string }
  | { kind: 'split' };

export function decideChoice(
  votes: WeightedAnswer[],
  rule: { votesNeeded: number; maxVotes: number; threshold: number }
): Decision {
  if (votes.length < rule.votesNeeded) return { kind: 'pending' };

  const byAnswer = new Map<string, number>();
  let total = 0;
  for (const vote of votes) {
    byAnswer.set(vote.answer, (byAnswer.get(vote.answer) ?? 0) + vote.weight);
    total += vote.weight;
  }

  if (total > 0) {
    for (const [answer, weight] of byAnswer) {
      if (weight / total >= rule.threshold) return { kind: 'resolved', value: answer };
    }
  }

  return votes.length >= rule.maxVotes ? { kind: 'split' } : { kind: 'pending' };
}

/** Levels are bit flags; a distance of more than one step down is for a moderator to decide. */
export function isExcessiveDownRating(current: number, winner: number): boolean {
  if (current <= 0 || winner <= 0 || winner >= current) return false;
  return Math.log2(current) - Math.log2(winner) > 1;
}
