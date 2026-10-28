import { KNIGHTS_STAGE_RANKS } from '@civitai/shared/new-order';

export const RANKS = ['Acolyte', 'Knight', 'Templar', 'Paladin', 'Inquisitor'] as const;
export type Rank = (typeof RANKS)[number];

/** Lowest first. Paladin weighs votes (RANK_WEIGHT) but is deliberately not an escalation stage. */
export const ESCALATION_PATH: readonly Rank[] = ['Knight', 'Templar', 'Inquisitor'];

export const RANK_WEIGHT: Record<Exclude<Rank, 'Inquisitor'>, number> = {
  Acolyte: 0,
  Knight: 1,
  Templar: 1.5,
  Paladin: 2,
};

export const FEED_STRETCH_SIZE = 10;

export const rankIndex = (rank: string): number => RANKS.indexOf(rank as Rank);

export const isRank = (value: string): value is Rank => rankIndex(value) !== -1;

export const isStageRank = (value: string): value is Rank =>
  (KNIGHTS_STAGE_RANKS as readonly string[]).includes(value);

export function nextRank(rank: string): Rank | null {
  const at = ESCALATION_PATH.indexOf(rank as Rank);
  if (at === -1) return null;
  return ESCALATION_PATH[at + 1] ?? null;
}

export const canVote = (playerRank: string, itemMinRank: string): boolean =>
  playerRank !== 'Acolyte' &&
  playerRank !== 'Inquisitor' &&
  rankIndex(playerRank) !== -1 &&
  rankIndex(playerRank) >= rankIndex(itemMinRank);

/** Same rule as `castVote`. */
export const stagesWorkedBy = (playerRank: string): Rank[] =>
  RANKS.filter((stage) => canVote(playerRank, stage));
