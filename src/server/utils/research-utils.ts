const LEVEL_BASE_RATINGS = 8; // Base number of ratings needed for the first level
const LEVEL_GROWTH_RATE = 1.15; // Growth rate for the exponential curve
export function calculateLevelProgression(totalRatings: number) {
  // Calculate current level based on total ratings
  let level = 0;
  let ratingsForNextLevel = LEVEL_BASE_RATINGS;

  while (totalRatings >= ratingsForNextLevel) {
    totalRatings -= ratingsForNextLevel;
    level++;
    ratingsForNextLevel = Math.floor(LEVEL_BASE_RATINGS * Math.pow(LEVEL_GROWTH_RATE, level));
  }

  // Calculate number of additional ratings needed for next level
  const ratingsRemaining = ratingsForNextLevel - totalRatings;
  const ratingsInLevel = ratingsForNextLevel - ratingsRemaining;
  const progress = Math.round((ratingsInLevel / ratingsForNextLevel) * 100);

  // For display purposes, start at level 1
  level += 1;

  return { level, ratingsForNextLevel, ratingsInLevel, ratingsRemaining, progress };
}
