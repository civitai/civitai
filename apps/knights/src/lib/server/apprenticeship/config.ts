/** The Acolyte apprenticeship: a continuous graded stream that pays XP and ends in knighthood. */
export const APPRENTICE = {
  xpPerCorrect: 100,
  /** The level a player must reach, with the accuracy bar held, to become a Knight. */
  knightLevel: 20,
  accuracyBar: 0.75,
  /** Accuracy and promotion read the player's most recent answers, this many at most. */
  window: 100,
  /** A recap of the last answers is shown after every this many. */
  checkpointEvery: 20,
  /** A recap offers the rating guide when accuracy is below this after `coachAfter` answers. */
  coachBelow: 0.6,
  coachAfter: 50,
  /** Every this-many-th item is a yes/no question; core and harvested images take turns in the rest. */
  yesNoEvery: 3,
  /** A smite once this many of the player's last `smiteWindow` answers are wrong; the count starts over after one. */
  smiteWrong: 6,
  smiteWindow: 20,
  milestones: [5, 10, 15],
} as const;
