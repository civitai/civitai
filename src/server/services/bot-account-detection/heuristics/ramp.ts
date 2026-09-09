/**
 * The one shape every heuristic in this directory turns a measurement into a score with.
 *
 * 🔴 ONE RAMP, NOT THREE. Each heuristic measures something with a different unit — items per hour,
 * accounts per IP, accounts per fingerprint — but all three answer the same question: "how far past
 * boring is this". Writing that arithmetic once means the three heuristics differ ONLY in what they
 * measure and where their two boundaries sit, which is what makes the sub-scores comparable enough
 * to sit beside each other in one reason string. It is also one place for the off-by-one to live
 * rather than three, and the boundary is the part every mutation check aims at.
 *
 * The two boundaries are named for what they DO, not for what they bound:
 *  - `zeroAt` — the largest value that is still worth nothing. A value equal to it scores exactly 0.
 *  - `oneAt`  — the smallest value that is worth everything. A value equal to it scores exactly 1.
 *
 * 🔴 THAT NAMING IS DELIBERATE AND IT IS THE OPPOSITE OF THE OBVIOUS ONE. Calling them `min`/`max`
 * invites reading `min` as "the smallest value that fires", which is off by one step in the
 * direction that makes a threshold fire earlier than its author intended — a detector's most
 * expensive kind of mistake, because it shows up as noise rather than as an error. With `zeroAt: 2`,
 * a cluster of THREE is the smallest that scores anything.
 */

/**
 * Linear interpolation between two boundaries, clamped at both ends.
 *
 * Returns 0 at or below `zeroAt`, 1 at or above `oneAt`, and the straight line between them
 * otherwise. A non-finite input scores 0 — it is a defect in whatever produced it, not a maximal
 * opinion, and the same reasoning `scoring.ts` gives for clamping `Infinity` down rather than up
 * applies here one layer earlier.
 *
 * `oneAt <= zeroAt` throws rather than returning something. It is not a value a caller could have
 * meant: the two boundaries would be inverted or coincident, every input would land on a degenerate
 * step, and the resulting heuristic would look calibrated while scoring 0 or 1 and nothing between.
 * A constant this wrong is a bug at module load, and it is better found there than averaged into a
 * moderator's queue.
 */
export function rampScore(value: number, zeroAt: number, oneAt: number): number {
  if (!(oneAt > zeroAt))
    throw new Error(`rampScore needs oneAt > zeroAt, got zeroAt=${zeroAt}, oneAt=${oneAt}`);
  if (!Number.isFinite(value)) return 0;
  if (value <= zeroAt) return 0;
  if (value >= oneAt) return 1;
  return (value - zeroAt) / (oneAt - zeroAt);
}
