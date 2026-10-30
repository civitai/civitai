/**
 * Derive precision and recall from the stored counters rather than reading the columns.
 *
 * `eval_run.precision` / `.recall` were written as `0` before those columns were made nullable, so
 * early runs render "P 0.000" — which reads as "the policy got everything wrong" when it means
 * "there was nothing to measure". Deriving is correct for those rows and for every future one, and
 * it is one fewer thing to remember to backfill.
 */
export type Counters = { tp: number; fp: number; fn: number };

export function precisionOf(r: Counters): number | null {
  return r.tp + r.fp === 0 ? null : r.tp / (r.tp + r.fp);
}

export function recallOf(r: Counters): number | null {
  return r.tp + r.fn === 0 ? null : r.tp / (r.tp + r.fn);
}

/** `n/a`, never `0.000`. An undefined metric is not a bad score. */
export function fmtMetric(n: number | null): string {
  return n === null ? 'n/a' : n.toFixed(3);
}
