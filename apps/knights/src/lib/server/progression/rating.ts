import { RANK_WEIGHT } from '../queue/ranks';
import { RANK_GOLD_MULTIPLIER, RANK_LADDER, RATING } from './config';

export type Ledger = { correct: number; graded: number };

export type Standing = { accuracy: number | null; bar: number | null; belowBar: boolean };

export type LadderEntry = (typeof RANK_LADDER)[number];

export const accuracyOf = ({ correct, graded }: Ledger): number | null =>
  graded < RATING.minGraded ? null : correct / graded;

const ladderIndex = (rank: string) => RANK_LADDER.findIndex((entry) => entry.rank === rank);

export function standingOf(rank: string, ledger: Ledger): Standing {
  const accuracy = accuracyOf(ledger);
  const entry = RANK_LADDER[ladderIndex(rank)];
  if (!entry) return { accuracy, bar: null, belowBar: false };
  return {
    accuracy,
    bar: entry.accuracyBar,
    belowBar: accuracy !== null && accuracy < entry.accuracyBar,
  };
}

export const nextLadderEntry = (rank: string): LadderEntry | null =>
  RANK_LADDER[ladderIndex(rank) + 1] ?? null;

/** The highest rank above `rank` whose level and accuracy bar are both met, or null. Only Knights, Templars and Paladins are on the ladder. */
export function earnedRank(rank: string, level: number, accuracy: number | null): string | null {
  const at = ladderIndex(rank);
  if (at === -1 || accuracy === null) return null;
  const earned = RANK_LADDER.slice(at + 1).filter(
    (entry) => level >= entry.fromLevel && accuracy >= entry.accuracyBar
  );
  return earned.at(-1)?.rank ?? null;
}

const levelsLabel = (index: number) => {
  const from = RANK_LADDER[index].fromLevel;
  const next = RANK_LADDER[index + 1];
  return next ? `${from}–${next.fromLevel - 1}` : `${from}+`;
};

export const rankTable = () =>
  RANK_LADDER.map((entry, index) => ({
    rank: entry.rank,
    levels: levelsLabel(index),
    accuracyBar: entry.accuracyBar,
    voteWeight: RANK_WEIGHT[entry.rank],
    goldMultiplier: RANK_GOLD_MULTIPLIER[entry.rank] ?? 1,
  }));
