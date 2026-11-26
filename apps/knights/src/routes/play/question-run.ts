export type RunCue = 'question-time' | 'questions-done' | null;

/** How long Question time stays up before the first question of a run, unless the player starts sooner. */
export const QUESTION_TIME_MS = 3000;
/** How long the "Questions done" banner sits over the first rating after a run, unless the player votes sooner. */
export const QUESTIONS_DONE_MS = 2500;

/**
 * What to show as an item comes on screen. Runs are read from what the page showed, not from the server's stretch banner:
 * a stretch of one category spans several bursts, and every burst is a new run for the player.
 * `wasQuestion` is the previous item's kind, null for the first item of the visit.
 */
export function runCue(wasQuestion: boolean | null, isQuestion: boolean): RunCue {
  if (isQuestion) return wasQuestion === true ? null : 'question-time';
  return wasQuestion === true ? 'questions-done' : null;
}
