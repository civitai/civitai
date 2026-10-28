export const RANKS = ['Acolyte', 'Knight', 'Templar', 'Paladin', 'Inquisitor'] as const;
export type Rank = (typeof RANKS)[number];

/** Ranks an item escalates through, lowest first. Paladin joins once the rank exists in the enum. */
export const ESCALATION_PATH: readonly Rank[] = ['Knight', 'Templar', 'Inquisitor'];

export const RANK_WEIGHT: Record<Exclude<Rank, 'Inquisitor'>, number> = {
  Acolyte: 0,
  Knight: 1,
  Templar: 1.5,
  Paladin: 2,
};

/** How long an escalated item may wait for its votes before moving up another rank. */
export const STAGE_TTL_HOURS = 72;

export const FEED_STRETCH_SIZE = 10;

export const rankIndex = (rank: string): number => RANKS.indexOf(rank as Rank);

export const isRank = (value: string): value is Rank => rankIndex(value) !== -1;

/** The rank an item moves to when its current stage cannot decide it, or null at the end of the path. */
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
