type Standing = {
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  goldEarned: number;
  goldPending: number;
};

/**
 * What a status read gained over the previous one, for the floating "+12 XP" and "+3 gold". Only gains show: a
 * conversion or a reset lowers the numbers and shows nothing. XP across a level boundary is the rest of the old
 * level plus what is into the new one.
 */
export function rewardDeltas(before: Standing | null, after: Standing) {
  if (!before) return { xp: 0, gold: 0, goldEarned: 0 };
  const xp =
    after.level === before.level
      ? after.xpIntoLevel - before.xpIntoLevel
      : after.level > before.level
      ? before.xpForNextLevel - before.xpIntoLevel + after.xpIntoLevel
      : 0;
  const goldEarned = after.goldEarned - before.goldEarned;
  const goldPending = after.goldPending - before.goldPending;
  return {
    xp: Math.max(0, xp),
    gold: Math.max(0, goldEarned) + Math.max(0, goldPending),
    goldEarned: Math.max(0, goldEarned),
  };
}
