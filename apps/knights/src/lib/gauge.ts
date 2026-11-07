import { count } from './format';

/** The share of the current level earned, kept inside 0..1 for a gauge. */
export function gaugeFraction(xpIntoLevel: number, xpForNextLevel: number): number {
  if (xpForNextLevel <= 0) return 0;
  return Math.min(1, Math.max(0, xpIntoLevel / xpForNextLevel));
}

/**
 * The level bar as two shares of the level, each 0..1: the confirmed fill, and the pending XP drawn right after it. Pending
 * stops at the end of the level (`overflow` is what spills past it): a vote still awaiting its verdict never shows a level-up.
 */
export function pendingSegment(xpIntoLevel: number, xpForNextLevel: number, xpPending: number) {
  const confirmed = gaugeFraction(xpIntoLevel, xpForNextLevel);
  if (xpForNextLevel <= 0) return { confirmed, pending: 0, overflow: 0 };
  const pending = Math.max(0, xpPending);
  const room = Math.max(0, xpForNextLevel - Math.max(0, xpIntoLevel));
  return {
    confirmed,
    pending: Math.min(pending, room) / xpForNextLevel,
    overflow: Math.max(0, pending - room),
  };
}

/** "876 / 5,163 XP · +360 pending". */
export const xpLine = (xpIntoLevel: number, xpForNextLevel: number, xpPending: number): string =>
  `${count(xpIntoLevel)} / ${count(xpForNextLevel)} XP${
    xpPending > 0 ? ` · +${count(xpPending)} pending` : ''
  }`;

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
    /** The rank's day requirement and the player's own count; absent on a status that does not carry them. */
    minDaysPlayed?: number;
    daysPlayed?: number;
    daysMet?: boolean;
  } | null;
};

export type Requirement = { key: 'level' | 'accuracy' | 'days'; text: string; met: boolean | null };

const pct = (ratio: number) => `${Math.round(ratio * 1000) / 10}%`;

/**
 * What the next rank asks, read from the config rows. Days played shows only for a rank that asks for it; the
 * player's own count and met flag come from the status when it carries them.
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
  const days = next.minDaysPlayed ?? ladder.find((row) => row.rank === next.rank)?.minDaysPlayed;
  if (days) {
    const have = next.daysPlayed;
    const met = have === undefined ? null : next.daysMet ?? have >= days;
    const stand = have === undefined ? '' : met ? ' · reached' : ` · you have ${have}`;
    out.push({ key: 'days', text: `At least ${days} days played${stand}`, met });
  }
  return out;
}
