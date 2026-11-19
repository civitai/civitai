import { NsfwLevel } from '@civitai/shared';
import {
  KNIGHTS_VOTE_NSFW_LEVEL_REASON,
  type KnightsWritebackReason,
} from '@civitai/shared/new-order';
import { getLevelProgression } from '../progression/levels';
import { penaltyFactor } from '../progression/config';
import { RANK_RULES, type Rank } from '../ranks';
import type { DecisionRule } from './stage-rules';

const WEIGHT_NEUTRAL_LEVEL = 20;
const LEVELS_PER_WEIGHT_UNIT = 60;
const SMITES_PER_WEIGHT_UNIT = 6;

export const levelForExp = (totalXp: number): number => getLevelProgression(totalXp).level;

export function voteWeight({
  rank,
  level,
  smites,
  belowBar = false,
}: {
  rank: Rank;
  level: number;
  smites: number;
  belowBar?: boolean;
}): number {
  const base = RANK_RULES[rank].voteWeight;
  if (base === 0) return 0;
  const weight =
    base +
    (level - WEIGHT_NEUTRAL_LEVEL) / LEVELS_PER_WEIGHT_UNIT -
    smites / SMITES_PER_WEIGHT_UNIT;
  return Math.max(0, Math.round(weight * penaltyFactor(belowBar) * 100) / 100);
}

/** Weights are rounded floats: 3 of 4 equal votes must still reach 75%. */
const SHARE_EPSILON = 1e-9;

export type WeightedAnswer = { answer: string; weight: number };

export type Decision =
  | { kind: 'pending' }
  | { kind: 'resolved'; value: string }
  | { kind: 'split' };

/** A vote of weight 0 (a held player's) is recorded but is not a vote here: it counts toward no quorum, maximum or share. */
export function decideChoice(cast: WeightedAnswer[], rule: DecisionRule): Decision {
  const votes = cast.filter((vote) => vote.weight > 0);
  if (votes.length < rule.votesNeeded) return { kind: 'pending' };
  const threshold =
    rule.unanimousAtNeeded && votes.length === rule.votesNeeded ? 1 : rule.threshold;

  const byAnswer = new Map<string, number>();
  let total = 0;
  for (const vote of votes) {
    byAnswer.set(vote.answer, (byAnswer.get(vote.answer) ?? 0) + vote.weight);
    total += vote.weight;
  }

  if (total > 0) {
    for (const [answer, weight] of byAnswer) {
      if (weight / total >= threshold - SHARE_EPSILON) return { kind: 'resolved', value: answer };
    }
  }

  return votes.length >= rule.maxVotes ? { kind: 'split' } : { kind: 'pending' };
}

/**
 * The level a rating that reached no consensus at its last stage is re-rated to: the answer with the most votes, counted (not
 * weighted, unlike `decideChoice`), a tie going to the highest level. A held player's weight-0 vote is not counted. Null with no
 * counted vote.
 */
export function mostVotedLevel(cast: WeightedAnswer[]): string | null {
  const counts = new Map<string, number>();
  for (const vote of cast) {
    if (vote.weight > 0) counts.set(vote.answer, (counts.get(vote.answer) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [answer, count] of counts) {
    if (count > bestCount || (count === bestCount && Number(answer) > Number(best))) {
      best = answer;
      bestCount = count;
    }
  }
  return best;
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
  | { kind: 'inquisitor'; reason: KnightsWritebackReason }
  | { kind: 'moderator'; level: number };

const isKnightsLocked = (image: Pick<ImageState, 'locked' | 'lockReason'>) =>
  image.locked && image.lockReason === KNIGHTS_VOTE_NSFW_LEVEL_REASON;

/**
 * A lock other than Knights' own is a moderator's ruling: its level, or the Inquisitors when it carries no usable level.
 * `moderatorRuledImageSql` (queue.service.ts) is its SQL form with `hasBlockMarker`; change them together.
 */
export function moderatorRuling(
  image: Pick<ImageState, 'locked' | 'lockReason' | 'nsfwLevel'>
): Extract<WritebackDecision, { kind: 'moderator' | 'inquisitor' }> | null {
  if (!image.locked || isKnightsLocked(image)) return null;
  return image.nsfwLevel > 0
    ? { kind: 'moderator', level: image.nsfwLevel }
    : { kind: 'inquisitor', reason: 'moderator-locked' };
}

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
  if (isKnightsLocked(image) && String(image.nsfwLevel) === settled.resolvedValue) {
    return { kind: 'already-applied' };
  }
  const ruling = moderatorRuling(image);
  if (ruling) return ruling;
  if (settled.resolvedFromLevel !== null && image.nsfwLevel !== settled.resolvedFromLevel) {
    return { kind: 'inquisitor', reason: 'level-moved' };
  }
  return { kind: 'apply' };
}
