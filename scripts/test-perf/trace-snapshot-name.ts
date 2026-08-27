/**
 * Everything `trace-setup.ts` (worker side) and `trace-config.mts` (config side) must agree on,
 * in ONE place, plus the pure resolvers both of them and their tests use.
 *
 * The filename shape is here because the writer creates these files and the config deletes the
 * previous run's, and the delete has to be scoped to this tool's own files — TESTPERF_TRACE_DIR is
 * caller-supplied. Two copies of that rule drift silently and in the dangerous direction: while the
 * writer used a bare `<pid>.json` and the deleter matched `<pid>-<suffix>.json`, the clear simply
 * stopped matching and a second traced run summed on top of the first with nothing to indicate it.
 */
import { existsSync, readdirSync, rmSync } from 'fs';
import path from 'path';

/**
 * `<pid>-<suffix>.json`. The suffix is regenerated each time the tracer initialises, which under
 * isolation is once per test FILE — so this is not one file per worker.
 *
 * 🔴 The `$` anchor is load-bearing: without it this also matches `1234-abcd.json.bak` and
 * `.json.swp`, i.e. editor and backup files sitting next to a caller's own data.
 */
export const SNAPSHOT_FILE_RE = /^\d+-[a-z0-9]+\.json$/;

export const snapshotFileName = (workerId: string) => `${workerId}.json`;

/**
 * The trace directory, from a caller-supplied env value.
 *
 * `||`, not `??`: an exported-but-empty `TESTPERF_TRACE_DIR=` is a string, so `??` keeps `''`,
 * `mkdirSync('')` throws, no snapshot is ever written, and `trace-report.mjs` then answers
 * "run a traced suite first" — reproducing precisely the dead-instrument failure this tooling was
 * fixed to eliminate.
 */
export function resolveTraceDir(raw: string | undefined, fallback: string): string {
  return raw && raw.trim() ? raw : fallback;
}

export const DEFAULT_TRACE_INTERVAL_MS = 15000;
/** Below this, the backstop is a hot loop rather than a backstop. */
export const MIN_TRACE_INTERVAL_MS = 1000;
/** Node's `TIMEOUT_MAX`. Anything larger is silently clamped to **1ms** — see below. */
export const MAX_TRACE_INTERVAL_MS = 2 ** 31 - 1;

/**
 * Milliseconds for the interval backstop, from a caller-supplied string.
 *
 * 🔴 Bounded at BOTH ends, and the upper bound is the non-obvious one. `setInterval` stores its
 * delay in a 32-bit signed int, so any value above `TIMEOUT_MAX` is clamped to **1ms** — measured
 * on Node 24.19.0, `1e10` fired 281 times in a 300ms window with
 * `TimeoutOverflowWarning: Timeout duration was set to 1`. That is a synchronous whole-snapshot
 * write ~900x/second inside every worker, charging its own cost to the measurement being taken —
 * the exact pathology this function exists to prevent, reachable from the "make it huge so it
 * never fires" direction. `Number` rather than `Number.parseInt` for the same reason from the
 * other side: parseInt reads `'1e10'` as 1 and `'15s'` as 15.
 */
export function resolveIntervalMs(raw: string | undefined): number {
  const n = Number(raw);
  // `Number(undefined)` is NaN and `Number('')` is 0, so both fall through to the default.
  return Number.isFinite(n) && n >= MIN_TRACE_INTERVAL_MS && n <= MAX_TRACE_INTERVAL_MS
    ? n
    : DEFAULT_TRACE_INTERVAL_MS;
}

/**
 * Deletes the previous run's snapshots, and nothing else.
 *
 * Per ENTRY, not around the loop: one undeletable snapshot — EACCES, or a directory that happens to
 * match the pattern, since `force` is not `recursive` — must not abandon every other stale file,
 * because whatever survives is summed into this run's numbers. Measured against a directory holding
 * one such entry plus five stale snapshots: per-entry leaves 0 survivors, loop-level leaves 5.
 *
 * Never throws: it runs at CONFIG LOAD, where a throw aborts the whole run with a raw stack.
 */
export function clearStaleSnapshots(dir: string, warn: (what: string, err: unknown) => void): void {
  let entries: string[];
  try {
    if (!existsSync(dir)) return;
    entries = readdirSync(dir);
  } catch (err) {
    warn(dir, err);
    return;
  }
  for (const f of entries) {
    if (!SNAPSHOT_FILE_RE.test(f)) continue;
    try {
      rmSync(path.join(dir, f), { force: true });
    } catch (err) {
      warn(path.join(dir, f), err);
    }
  }
}
