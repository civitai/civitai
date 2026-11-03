import { browsingLevelDescriptions, browsingLevelLabels, NsfwLevel } from '@civitai/shared';
import { DAILY, streakBonusGold } from './daily/config';
import { goldForRank, PROGRESSION, RATING } from './progression/config';
import { rankTable } from './progression/rating';
import { SMITES } from './smites/config';
import { APPRENTICE } from './apprenticeship/config';

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

/** Numbers the rules page quotes, read from the game's config. */
export function rulesFacts(yesNoJudges: number) {
  return {
    apprenticeship: {
      xpPerCorrect: APPRENTICE.xpPerCorrect,
      knightLevel: APPRENTICE.knightLevel,
      accuracyPercent: Math.round(APPRENTICE.accuracyBar * 100),
      window: APPRENTICE.window,
      checkpointEvery: APPRENTICE.checkpointEvery,
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
    yesNo: { judgesNeeded: yesNoJudges },
    hearts: SMITES.max,
    ratingGuide: ratingGuide(),
  };
}
