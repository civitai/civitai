const BASE_XP_FOR_NEXT_LEVEL = 250;
const XP_GROWTH_RATE = 1.18;

/** The Knights of New Order level curve; every app that shows or weighs a level reads it from here. */
export function getLevelProgression(totalXp: number) {
  let level = 1;
  let xpForCurrentLevel = 0;
  let xpForNextLevel = BASE_XP_FOR_NEXT_LEVEL;

  while (totalXp >= xpForNextLevel) {
    totalXp -= xpForNextLevel;
    level++;
    xpForCurrentLevel = xpForNextLevel;
    xpForNextLevel = Math.floor(xpForNextLevel * XP_GROWTH_RATE);
  }

  const xpIntoLevel = totalXp;
  const xpToNextLevel = xpForNextLevel - xpIntoLevel;
  const progressPercent = Math.min((xpIntoLevel / xpForNextLevel) * 100, 100);

  return {
    level,
    totalXp: xpIntoLevel,
    xpForCurrentLevel,
    xpForNextLevel,
    xpIntoLevel,
    xpToNextLevel,
    progressPercent: Math.round(progressPercent * 100) / 100,
  };
}
