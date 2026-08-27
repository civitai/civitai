/**
 * The pieces `trace-setup.ts` (worker side) and `trace-config.mts` (config side) must agree on,
 * in ONE place.
 *
 * The filename shape is here because the writer creates these files and the config deletes the
 * previous run's, and the delete has to be scoped to this tool's own files — TESTPERF_TRACE_DIR is
 * caller-supplied. Two copies of that rule drift silently and in the dangerous direction: while the
 * writer used a bare `<pid>.json` and the deleter matched `<pid>-<suffix>.json`, the clear simply
 * stopped matching and a second traced run summed on top of the first with nothing to indicate it.
 */

/** `<pid>-<per-file suffix>.json` — see `workerId` in trace-setup.ts. */
export const SNAPSHOT_FILE_RE = /^\d+-[a-z0-9]+\.json$/;

export const snapshotFileName = (workerId: string) => `${workerId}.json`;

/**
 * Milliseconds for the interval backstop, from a caller-supplied string.
 *
 * Validated rather than coerced, because every wrong answer here is the same wrong answer: Node
 * clamps NaN, 0 and negatives to a **1ms** timer, which turns the backstop into a synchronous
 * whole-snapshot write ~900x/second inside every worker and charges its own cost to the measurement
 * being taken. `Number` rather than `Number.parseInt`: parseInt reads `'1e10'` as **1** — landing on
 * exactly that pathology — and `'15s'` as 15.
 */
export const DEFAULT_TRACE_INTERVAL_MS = 15000;

export function resolveIntervalMs(raw: string | undefined): number {
  const n = Number(raw);
  // `Number(undefined)` is NaN and `Number('')` is 0, so both fall through to the default; the
  // `>= 1` bound is what keeps a sub-millisecond timer unreachable.
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_TRACE_INTERVAL_MS;
}
