import { browsingLevelDescriptions, browsingLevelLabels, NsfwLevel } from '@civitai/shared';
import { DAILY, streakBonusGold } from './daily/config';
import { goldForRank, PROGRESSION, RATING } from './progression/config';
import { rankTable } from './progression/rating';
import { SMITES } from './smites/config';
import { TRIALS } from './trials/config';

const RATING_GUIDE_LEVELS = [
  NsfwLevel.PG,
  NsfwLevel.PG13,
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
  NsfwLevel.Blocked,
] as const;

/** Numbers the rules page quotes, read from the game's config. */
export function rulesFacts() {
  return {
    trials: {
      length: TRIALS.runLength,
      passPercent: Math.round(TRIALS.passMark * 100),
      cooldownHours: TRIALS.cooldownHours,
    },
    ranks: rankTable().map((r) => ({
      rank: r.rank,
      levels: r.levels,
      accuracyPercent: Math.round(r.accuracyBar * 100),
    })),
    accuracy: { window: PROGRESSION.fervorWindow, minGraded: RATING.minGraded },
    xp: { atVote: PROGRESSION.voteXp, onCorrect: PROGRESSION.correctXp },
    gold: {
      perCorrectVote: goldForRank('Knight'),
      belowBarFactor: RATING.belowBarFactor,
    },
    watch: {
      size: DAILY.watchSize,
      bonusGold: streakBonusGold(1),
      streakCap: DAILY.streakCap,
      maxShields: DAILY.maxShields,
    },
    hearts: SMITES.max,
    ratingGuide: RATING_GUIDE_LEVELS.map((level) => ({
      level,
      label: browsingLevelLabels[level],
      description: browsingLevelDescriptions[level],
    })),
  };
}
