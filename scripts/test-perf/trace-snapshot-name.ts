/**
 * The snapshot filename shape, in ONE place.
 *
 * `trace-setup.ts` writes these files and `trace-config.mts` deletes the previous run's, and the
 * delete has to be scoped to this tool's own files because TESTPERF_TRACE_DIR is caller-supplied.
 * Two copies of that rule drift silently and in the dangerous direction: while the writer used a
 * bare `<pid>.json` and the deleter matched `<pid>-<suffix>.json`, the clear simply stopped
 * matching and a second traced run summed on top of the first with nothing to indicate it.
 */

/** `<pid>-<per-worker suffix>.json` — see `workerId` in trace-setup.ts. */
export const SNAPSHOT_FILE_RE = /^\d+-[a-z0-9]+\.json$/;

export const snapshotFileName = (workerId: string) => `${workerId}.json`;
