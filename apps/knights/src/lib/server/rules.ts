import { browsingLevelDescriptions, browsingLevelLabels, NsfwLevel } from '@civitai/shared';
import { DAILY, DAILY_GOLD_CAP_BY_LEVEL, streakBonusGold } from './daily/config';
import { goldForRank, PROGRESSION, RATING } from './progression/config';
import { rankTable } from './progression/rating';
import { SMITES } from './smites/config';
import { APPRENTICE } from './apprenticeship/config';
import { STREAK_BADGE_IDS } from './daily/streak-badges';

const RATING_GUIDE_LEVELS = [
  NsfwLevel.PG,
  NsfwLevel.PG13,
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
  NsfwLevel.Blocked,
] as const;

/** What each rating level means, as shown on the rules page, the first-visit guide and the answer buttons. */
export function ratingGuide() {
  return RATING_GUIDE_LEVELS.map((level) => ({
    level,
    label: browsingLevelLabels[level],
    description: browsingLevelDescriptions[level],
  }));
}

/** The Watch-streak days that earn a badge; a milestone whose badge is not set up yet is left out. */
export const badgeStreaksOf = (ids: Record<number, number | null>) =>
  Object.entries(ids)
    .filter(([, id]) => id !== null)
    .map(([milestone]) => Number(milestone))
    .sort((a, b) => a - b);

/** Numbers the rules page quotes, read from the game's config. */
export function rulesFacts() {
  return {
    apprenticeship: {
      xpPerCorrect: APPRENTICE.xpPerCorrect,
      knightLevel: APPRENTICE.knightLevel,
      accuracyPercent: Math.round(APPRENTICE.accuracyBar * 100),
      window: APPRENTICE.window,
      checkpointEvery: APPRENTICE.checkpointEvery,
      levelGold: PROGRESSION.acolyteLevelGold,
    },
    ranks: rankTable().map((r) => ({
      rank: r.rank,
      levels: r.levels,
      accuracyPercent: Math.round(r.accuracyBar * 100),
      minDaysPlayed: r.minDaysPlayed,
    })),
    accuracy: { window: PROGRESSION.accuracyWindow, minGraded: RATING.minGraded },
    xp: { atVote: PROGRESSION.voteXp, onCorrect: PROGRESSION.correctXp },
    gold: {
      perCorrectVote: goldForRank('Knight'),
      belowBarFactor: RATING.belowBarFactor,
      dailyCap: {
        firstLevel: DAILY_GOLD_CAP_BY_LEVEL[0].fromLevel,
        first: DAILY_GOLD_CAP_BY_LEVEL[0].gold,
        topLevel: DAILY_GOLD_CAP_BY_LEVEL.at(-1)!.fromLevel,
        top: DAILY_GOLD_CAP_BY_LEVEL.at(-1)!.gold,
      },
    },
    watch: {
      size: DAILY.watchSize,
      bonusGold: streakBonusGold(1),
      streakCap: DAILY.streakCap,
      maxShields: DAILY.maxShields,
      badgeStreaks: badgeStreaksOf(STREAK_BADGE_IDS),
    },
    fervor: {
      scale: PROGRESSION.fervorScale,
      windowDays: PROGRESSION.fervorWindowDays,
      accuracyFloorPercent: PROGRESSION.fervorAccuracyFloor * 100,
    },
    hearts: { max: SMITES.max, returnAfterDays: SMITES.expireAfterDays },
    ratingGuide: ratingGuide(),
  };
}
