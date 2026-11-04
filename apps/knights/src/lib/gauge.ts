/** The share of the current level earned, kept inside 0..1 for a gauge. */
export function gaugeFraction(xpIntoLevel: number, xpForNextLevel: number): number {
  if (xpForNextLevel <= 0) return 0;
  return Math.min(1, Math.max(0, xpIntoLevel / xpForNextLevel));
}

type LadderRow = { rank: string; fromLevel: number; accuracyBar: number; minDaysPlayed?: number };

type Standing = {
  level: number;
  rating: { accuracy: number | null };
  nextRank: {
    rank: string;
    fromLevel: number;
    accuracyBar: number;
    levelsToGo: number;
    levelMet: boolean;
    accuracyMet: boolean;
  } | null;
};

export type Requirement = { key: 'level' | 'accuracy' | 'days'; text: string; met: boolean | null };

const pct = (ratio: number) => `${Math.round(ratio * 1000) / 10}%`;

/**
 * What the next rank asks, read from the config rows. Days played shows only for a rank whose ladder row carries
 * `minDaysPlayed`; the player's own count is not part of the status, so it has no met flag.
 */
export function nextRankRequirements(
  status: Standing,
  ladder: readonly LadderRow[]
): Requirement[] {
  const next = status.nextRank;
  if (!next) return [];
  const out: Requirement[] = [
    {
      key: 'level',
      text: next.levelMet
        ? `Level ${next.fromLevel} · reached`
        : `Level ${next.fromLevel} · ${next.levelsToGo} ${
            next.levelsToGo === 1 ? 'level' : 'levels'
          } to go`,
      met: next.levelMet,
    },
    {
      key: 'accuracy',
      text: `Accuracy ${pct(next.accuracyBar)}+ · ${
        status.rating.accuracy === null
          ? 'not yet rated'
          : `you are at ${pct(status.rating.accuracy)}`
      }`,
      met: next.accuracyMet,
    },
  ];
  const days = ladder.find((row) => row.rank === next.rank)?.minDaysPlayed;
  if (days) out.push({ key: 'days', text: `At least ${days} days played`, met: null });
  return out;
}
