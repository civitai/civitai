import type { StoredSettings } from '../settings/stored';

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
  /** Every this-many-th item is a yes/no question; the rest are core images, harvested ones only once core runs out. */
  yesNoEvery: 3,
  /** A smite once this many of the player's last `smiteWindow` answers are wrong; the count starts over after one. */
  smiteWrong: 6,
  smiteWindow: 20,
  milestones: [5, 10, 15],
} as const;

export type ApprenticeSettings = {
  /** Whether too many wrong answers earn a smite. */
  smites: boolean;
};

/**
 * The switch saved on the moderator Config page wins (`stored`); without one, the environment (see `.env.example`):
 * `KNIGHTS_APPRENTICE_SMITES=off` stops the wrong-answer smite.
 */
export function apprenticeSettings(
  env: Record<string, string | undefined>,
  stored: StoredSettings = {}
): ApprenticeSettings {
  return {
    smites:
      stored.apprenticeSmites ?? env.KNIGHTS_APPRENTICE_SMITES?.trim().toLowerCase() !== 'off',
  };
}
