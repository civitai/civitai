import { NsfwLevel } from '@civitai/shared';
import { KNIGHTS_VOTE_NSFW_LEVEL_REASON } from '@civitai/shared/new-order';
import { getLevelProgression } from '@civitai/shared/new-order-levels';
import { RANK_WEIGHT, type Rank } from './ranks';

const WEIGHT_NEUTRAL_LEVEL = 20;
const LEVELS_PER_WEIGHT_UNIT = 60;
const SMITES_PER_WEIGHT_UNIT = 6;

export const levelForExp = (totalXp: number): number => getLevelProgression(totalXp).level;

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
  const weight =
    base +
    (level - WEIGHT_NEUTRAL_LEVEL) / LEVELS_PER_WEIGHT_UNIT -
    smites / SMITES_PER_WEIGHT_UNIT;
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

// Levels are bit flags, so a "step" is a power of two.
export function isExcessiveDownRating(current: number, winner: number): boolean {
  if (current <= 0 || winner <= 0 || winner >= current) return false;
  return Math.log2(current) - Math.log2(winner) > 1;
}

/** Blocking an image is a moderator's decision, so a consensus on it is handed to the Inquisitors. */
export const isBlockedLevel = (value: number): boolean => value === NsfwLevel.Blocked;

export type ImageState = {
  nsfwLevel: number;
  locked: boolean;
  lockReason: string | null;
  ingestion: string;
  blockedFor: string | null;
};

/** Mirrors the main app's block marker: any one of the three means the image is blocked. */
export const hasBlockMarker = (image: Pick<ImageState, 'nsfwLevel' | 'ingestion' | 'blockedFor'>) =>
  image.ingestion === 'Blocked' ||
  image.nsfwLevel === NsfwLevel.Blocked ||
  image.blockedFor != null;

export type WritebackDecision =
  | { kind: 'apply' }
  | { kind: 'already-applied' }
  | { kind: 'missing' }
  | { kind: 'inquisitor'; reason: 'blocked' | 'level-moved' | 'moderator-locked' }
  | { kind: 'moderator'; level: number };

/**
 * Whether a settled rating may still be written. `resolvedFromLevel` is the level the players'
 * image had when they settled; an image that has since moved is a moderator's to look at. An image
 * already at the settled level under the Knights lock was written by an earlier try whose answer
 * was lost, so there is nothing left to write.
 */
export function decideWriteback(
  image: ImageState | null,
  settled: { resolvedFromLevel: number | null; resolvedValue: string }
): WritebackDecision {
  if (!image) return { kind: 'missing' };
  if (hasBlockMarker(image)) return { kind: 'inquisitor', reason: 'blocked' };
  const knightsLocked = image.locked && image.lockReason === KNIGHTS_VOTE_NSFW_LEVEL_REASON;
  if (knightsLocked && String(image.nsfwLevel) === settled.resolvedValue) {
    return { kind: 'already-applied' };
  }
  if (image.locked && !knightsLocked) {
    return image.nsfwLevel > 0
      ? { kind: 'moderator', level: image.nsfwLevel }
      : { kind: 'inquisitor', reason: 'moderator-locked' };
  }
  if (settled.resolvedFromLevel !== null && image.nsfwLevel !== settled.resolvedFromLevel) {
    return { kind: 'inquisitor', reason: 'level-moved' };
  }
  return { kind: 'apply' };
}
