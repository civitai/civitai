/**
 * The one shape every heuristic in this directory turns a measurement into a score with.
 *
 * 🔴 ONE RAMP, NOT FOUR. Each heuristic measures something with a different unit — items per hour,
 * accounts per IP, accounts per email domain, accounts per fingerprint, staged uploads, staged
 * uploads inside one second — but all of them answer the same question: "how far past boring is
 * this". Writing that arithmetic once means the heuristics differ ONLY in what they measure and
 * where their two boundaries sit, which is what makes the sub-scores comparable enough to sit beside
 * each other in one reason string. It is also one place for the off-by-one to live rather than
 * seven, and the boundary is the part every mutation check aims at.
 *
 * (Four heuristics, seven call sites: `velocity.ts`, `clustering.ts` twice, `similarity.ts` twice,
 * `staging.ts` twice. The count is stated because the paragraphs below reason about the callers as
 * a set — one of them specifically about `asset-staging`, which an earlier "NOT THREE" wording had
 * left out of the list entirely.)
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
 * step, and the resulting heuristic would look calibrated while never scoring anything between its
 * two ends. A constant this wrong is a bug at module load, and it is better found there than
 * averaged into a moderator's queue.
 *
 * 🔴 WHAT THE THROW DOES NOT GUARD, BECAUSE THE OBVIOUS READING IS WRONG AND LEADS SOMEONE TO
 * DELETE IT: for an ORDERED-BUT-DEGENERATE pair it is not protecting the division. With the throw
 * removed, `oneAt <= zeroAt` never reaches the interpolation at all — the two clamps below cover the
 * entire real line (coincident, every finite value is at or outside one end; inverted, the ranges
 * overlap and `<= zeroAt` is tested first), so there is no division by zero and no `NaN` to catch.
 * The failure it prevents there is silent, not loud: a ramp that has quietly become a step at
 * `zeroAt` while its constants still read like a calibrated pair.
 *
 * The guard is written `!(oneAt > zeroAt)` rather than `oneAt <= zeroAt`, which is WIDER — it also
 * fires when a boundary is `NaN`, and that case genuinely does reach the division and return `NaN`.
 * No call site can produce it today (all seven pass integer module constants), so that is precision
 * about the guard rather than a hazard; do not narrow the comparison on the strength of the
 * paragraph above.
 *
 * 🔴 AND A STEP IS NOT ITSELF A BUG — ONE CALL SITE SHIPS ONE DELIBERATELY, WITH A VALID PAIR. The
 * general rule, which is all this file needs to state: a call site whose two boundaries are ADJACENT
 * INTEGERS, fed integer inputs, never reaches the interpolation below — the ramp is a step there,
 * deliberately or not — so a mutation of that line is invisible through that call site and must be
 * killed through one whose boundaries are further apart. Read it as the CALL SITE and not the
 * heuristic: the two are not the same, and a heuristic with a second, wider call site does kill such
 * a mutant. One caller ships exactly that shape on purpose; its constants, its reasoning and the
 * worked coverage consequence are on `STAGED_ONE_AT` and in the case named "starts at 0 below the
 * volume boundary, saturates ON it, and stays there", not restated here — a caller's constants
 * copied into the shared helper go stale silently the next time that caller is tuned.
 */
export function rampScore(value: number, zeroAt: number, oneAt: number): number {
  if (!(oneAt > zeroAt))
    throw new Error(`rampScore needs oneAt > zeroAt, got zeroAt=${zeroAt}, oneAt=${oneAt}`);
  if (!Number.isFinite(value)) return 0;
  if (value <= zeroAt) return 0;
  if (value >= oneAt) return 1;
  return (value - zeroAt) / (oneAt - zeroAt);
}
