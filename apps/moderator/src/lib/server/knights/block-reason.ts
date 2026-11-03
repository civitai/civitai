import { NsfwLevel } from '@civitai/shared';

/** The reasons a Knight gives for a Blocked rating: the original game's `NewOrderDamnedReason` names, labelled as the Knights app shows them. */
export const BLOCK_REASON_LABELS: Record<string, string> = {
  InappropriateMinors: 'Inappropriate Minors',
  RealisticMinors: 'Realistic Minors',
  DepictsRealPerson: 'Depicts Real Person',
  Bestiality: 'Bestiality',
  Other: 'Other',
};

export type ConsensusBlockReason = {
  reason: string;
  label: string;
  /** Blocked votes that gave this reason. */
  count: number;
  /** All Blocked votes on the item, with or without a reason. */
  of: number;
};

export type BlockedVote = {
  answer: string;
  blockReason: string | null;
  createdAt: Date;
  playerId: number;
};

/**
 * The reason most Blocked votes gave; a tie goes to the reason of the earliest vote among the tied.
 * Null when no Blocked vote carried a reason (votes cast before reasons were asked).
 */
export function consensusBlockReason(votes: BlockedVote[]): ConsensusBlockReason | null {
  const blocked = votes.filter((vote) => vote.answer === String(NsfwLevel.Blocked));
  const reasoned = blocked
    .filter((vote) => vote.blockReason !== null && vote.blockReason in BLOCK_REASON_LABELS)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.playerId - b.playerId);
  if (reasoned.length === 0) return null;

  const counts = new Map<string, number>();
  for (const vote of reasoned)
    counts.set(vote.blockReason!, (counts.get(vote.blockReason!) ?? 0) + 1);
  const top = Math.max(...counts.values());
  // `reasoned` is in vote order, so the first reason with the top count owns the earliest vote among the tied.
  const reason = reasoned.find((vote) => counts.get(vote.blockReason!) === top)!.blockReason!;
  return { reason, label: BLOCK_REASON_LABELS[reason], count: top, of: blocked.length };
}
