import { newOrderConfig } from '~/server/common/constants';
import { getLevelProgression } from '@civitai/shared/new-order-levels';
import type { NsfwLevel } from '~/server/common/enums';

export { getLevelProgression };

export function calculateExp({
  currentExp,
  rating,
  currentRating,
}: {
  currentExp: number;
  rating: NsfwLevel;
  currentRating: NsfwLevel;
}) {
  const isCorrectRating = rating === currentRating;
  const { xpIntoLevel } = getLevelProgression(currentExp);

  let newExp = currentExp;
  if (isCorrectRating) {
    newExp = currentExp + newOrderConfig.baseExp;

    return { newExp, gainedExp: newOrderConfig.baseExp, multiplier: 1 };
  } else {
    // Calculate XP deduction based on how far off the rating was
    const ratingDifference = Math.abs(Number(currentRating) - Number(rating));
    const baseDeduction = newOrderConfig.baseExp / 2; // Half of the base XP
    const multiplier = Math.min(ratingDifference, 4); // Cap at 4x multiplier
    const xpDeduction = baseDeduction * multiplier;

    // Ensure we don't drop below current level
    const belowLevelThreshold = xpIntoLevel - xpDeduction < 0;
    newExp = belowLevelThreshold ? currentExp - xpIntoLevel : currentExp - xpDeduction;

    return {
      newExp,
      gainedExp: baseDeduction,
      multiplier: belowLevelThreshold ? 0 : multiplier * -1,
    };
  }
}
