import { APPRENTICE } from './config';

export type Window = { correct: number; graded: number };

export const accuracyOf = ({ correct, graded }: Window): number | null =>
  graded === 0 ? null : correct / graded;

/** The level is reached and the most recent full window of answers is at the bar. */
export function earnsKnighthood({ level, correct, graded }: Window & { level: number }): boolean {
  return (
    level >= APPRENTICE.knightLevel &&
    graded >= APPRENTICE.window &&
    correct / graded >= APPRENTICE.accuracyBar
  );
}

export const isCheckpoint = (answered: number): boolean =>
  answered > 0 && answered % APPRENTICE.checkpointEvery === 0;

export const needsCoaching = (answered: number, accuracy: number | null): boolean =>
  answered >= APPRENTICE.coachAfter && accuracy !== null && accuracy < APPRENTICE.coachBelow;

export type Source = 'core' | 'rating' | 'yesno';

/**
 * Which kind of item comes next. The curated core set always comes first; after that yes/no questions are mixed in
 * on a fixed rhythm by the player's answer count, and either kind stands in when the other has run out.
 */
export function chooseSource(input: {
  position: number;
  core: boolean;
  rating: boolean;
  yesNo: boolean;
}): Source | null {
  if (input.core) return 'core';
  if (!input.rating && !input.yesNo) return null;
  if (!input.yesNo) return 'rating';
  if (!input.rating) return 'yesno';
  return input.position % APPRENTICE.yesNoEvery === APPRENTICE.yesNoEvery - 1 ? 'yesno' : 'rating';
}

const MILESTONE_COPY: Record<number, string> = {
  5: 'Level 5 — a fine start on the road to Knight',
  10: 'Level 10 — halfway to Knight',
  15: 'Level 15 — nearly a Knight',
};

export const milestoneCopy = (level: number): string | null => MILESTONE_COPY[level] ?? null;

/** The highest milestone in (from, to], so a jump past one (two levels in a load) still celebrates it. */
export function crossedMilestone(from: number, to: number): { level: number; copy: string } | null {
  for (let level = to; level > from; level--) {
    const copy = milestoneCopy(level);
    if (copy) return { level, copy };
  }
  return null;
}

/** The milestone before `level`, or 1 (the start) when there is none. */
export function previousMilestone(level: number): number {
  let previous = 1;
  for (const key of Object.keys(MILESTONE_COPY).map(Number)) {
    if (key < level && key > previous) previous = key;
  }
  return previous;
}
