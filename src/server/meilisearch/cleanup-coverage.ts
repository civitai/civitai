/**
 * THE single definition of "this cleanup pass reached the end of the index".
 *
 * 🔴 This module exists because that predicate was open-coded twice and the two copies
 * DISAGREED. `cleanupIndex` cleared its resume cursor at >= 50% coverage while the job
 * logged `incomplete: true` below 75%, so a pass landing in [0.50, 0.75) reported itself
 * truncated at error level AND threw its resume point away in the same run — the next
 * run restarted at the bottom, which is exactly the defect the cursor exists to fix,
 * intact above 50%. One rule, one place: both consumers call this, so the log verdict
 * and the cursor decision cannot drift apart again.
 *
 * The band itself is unchanged from the one the job already used, and is calibrated
 * against two independent failure directions:
 *
 *  - The RATIO alone would make a small index shout over a few hundred documents.
 *  - The FLOOR alone would let a 10%-covered multi-million-document index pass.
 *
 * They are deliberately NOT redundant, and the tests pin each one with a fixture where
 * only that clause is decisive.
 */

/**
 * How far the pass may fall short of the pre-scan document count, as a fraction, before
 * the count refutes the loop's own claim to have finished.
 *
 * A shortfall is NORMAL: `totalInIndex` is a snapshot taken before a scan that then runs
 * for a long time against indexes another job deletes from every few minutes, so the two
 * numbers legitimately disagree on a perfectly complete run. The band is a judgement, not
 * a measurement, and is deliberately loose — the real incident it has to catch was an 84%
 * shortfall.
 */
export const COVERAGE_SHORTFALL_RATIO = 0.25;

/**
 * Absolute floor beneath which a shortfall is never treated as evidence of anything.
 *
 * Consequence worth stating plainly: an index holding fewer than ~1,333 documents can
 * never be judged low-coverage, so a pass over one always counts as having reached the
 * end. That is intended — such an index is walked in a page or two and there is nothing
 * to resume. A pass that stopped early is still incomplete regardless of this floor,
 * because `stoppedEarly` is a fact about how the loop exited, not a count.
 */
export const COVERAGE_SHORTFALL_FLOOR = 1000;

export type PassCoverageInput = {
  /** The loop exited for any reason other than its own terminator. */
  stoppedEarly: boolean;
  /**
   * Ids walked past by the whole PASS — this run plus every earlier run it resumed from.
   * NOT the run's own `idsScanned`: a resumed run scans only the remainder of the index,
   * so judging it on its own count files every resumed run as truncated.
   */
  passCovered: number;
  /** The engine's pre-scan document count, or null if it could not be read. */
  totalInIndex: number | null;
  /** Whether the engine was mid-ingest when that count was taken. */
  indexingAtStart: boolean | null;
};

export type PassCoverageVerdict = {
  /**
   * 🔴 The one definition. True means: end the pass, clear the resume cursor, and report
   * a healthy run. False means: the pass did not finish, so it keeps its cursor AND is
   * reported incomplete. These two consequences are now the same boolean by construction.
   */
  reachedEnd: boolean;
  /** The loop terminated, but the document count refutes it. */
  lowCoverage: boolean;
  coverage: number | null;
  shortfall: number | null;
};

export function assessPassCoverage(r: PassCoverageInput): PassCoverageVerdict {
  const total = r.totalInIndex;
  const coverage = total !== null && total > 0 ? r.passCovered / total : null;
  const shortfall = total === null ? null : total - r.passCovered;

  const lowCoverage =
    !r.stoppedEarly &&
    shortfall !== null &&
    // A count taken while the engine was mid-ingest is a moving number, so a shortfall
    // against it is not evidence of anything.
    r.indexingAtStart !== true &&
    shortfall > COVERAGE_SHORTFALL_FLOOR &&
    shortfall > (total as number) * COVERAGE_SHORTFALL_RATIO;

  return { reachedEnd: !r.stoppedEarly && !lowCoverage, lowCoverage, coverage, shortfall };
}
