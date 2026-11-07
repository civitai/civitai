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
  /** Once the curated core set is used up, every this-many-th item is a yes/no question. */
  yesNoEvery: 3,
  milestones: [5, 10, 15],
} as const;
