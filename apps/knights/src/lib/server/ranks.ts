/** Lowest first; the position is the order of rank everywhere (feed, ladder). */
export const RANKS = ['Acolyte', 'Knight', 'Templar', 'Paladin', 'Inquisitor'] as const;
export type Rank = (typeof RANKS)[number];

export const RANK_RULES: Record<Rank, { voteWeight: number; goldMultiplier: number }> = {
  Acolyte: { voteWeight: 0, goldMultiplier: 0 },
  Knight: { voteWeight: 1, goldMultiplier: 1 },
  Templar: { voteWeight: 1.5, goldMultiplier: 1.25 },
  Paladin: { voteWeight: 2, goldMultiplier: 1.5 },
  Inquisitor: { voteWeight: 0, goldMultiplier: 0 },
};

export const rankIndex = (rank: string): number => RANKS.indexOf(rank as Rank);

export const isRank = (value: string): value is Rank => rankIndex(value) !== -1;

/**
 * Whether the player chooses what Knights serves them (the yes/no switch, hidden tag groups). Acolytes do not: their
 * practice questions and graded set are part of training.
 */
export const tunesServing = (rank: string): boolean => rank !== 'Acolyte';
