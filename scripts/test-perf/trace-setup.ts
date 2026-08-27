/**
 * Installs the module-execution counters used by `trace-config.mts` and flushes them.
 *
 * Runs before the real setup file, so the counters exist by the time anything else is imported.
 * State hangs off `globalThis` so a within-file `vi.resetModules()` cannot re-register the hooks or
 * reset the counters mid-file.
 *
 * ⚠️ It does NOT accumulate across files, and an earlier version of this comment claimed it did.
 * Measured on both pools: each test file gets a fresh registry (and on `forks` a fresh process), so
 * each writes a snapshot naming only its own modules — 2 fixtures produced 2 disjoint snapshots on
 * `threads` (one pid) and on `forks` (two pids). Per-run totals are correct because
 * `trace-report.mjs` SUMS the snapshots, not because any one worker accumulates them.
 *
 * 🔴 `afterAll` is the load-bearing flush; the other two are backstops. Vitest's `forks` pool
 * KILLS its workers rather than letting them exit, so `process.on('exit')` never fires — under
 * Vitest 4.1.11 a traced run wrote nothing at all, and `trace-report.mjs` answered
 * "no .test-perf/trace — run a traced suite first", which reads as operator error rather than as
 * a dead instrument. The 15s interval did not cover it either: the README's own workflow is
 * "trace one file at a time", which is a 5–10s run. Measured across four runs while diagnosing
 * this: four `afterAll` snapshots, zero exit snapshots.
 */
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { afterAll } from 'vitest';
import { resolveIntervalMs, resolveTraceDir, snapshotFileName } from './trace-snapshot-name';

type Entry = { loads: number; selfMs: number; totalMs: number };

const g = globalThis as any;

if (!g.__modTrace) {
  const stats = new Map<string, Entry>();
  const stack: { id: string; start: number; childMs: number }[] = [];
  g.__modTrace = stats;

  g.__modTraceIn = (id: string) => {
    stack.push({ id, start: performance.now(), childMs: 0 });
  };

  g.__modTraceOut = (id: string) => {
    // A module can be re-entered through a cycle; unwind to the matching frame rather than
    // trusting the top of the stack, or one cycle corrupts every enclosing measurement.
    let i = stack.length - 1;
    while (i >= 0 && stack[i].id !== id) i--;
    if (i < 0) return;
    const frame = stack[i];
    stack.length = i;
    const total = performance.now() - frame.start;
    const self = total - frame.childMs;
    if (stack.length) stack[stack.length - 1].childMs += total;
    const e = stats.get(id) ?? { loads: 0, selfMs: 0, totalMs: 0 };
    e.loads++;
    e.selfMs += self;
    e.totalMs += total;
    stats.set(id, e);
  };

  // 🔴 pid is NOT a unique worker id on a thread pool. `forks` gives one process per file, so
  // `<pid>.json` happens to be unique there — but `threads`/`vmThreads` put every worker in ONE
  // process, so several workers flush to the same path. Measured: 3 files gave 3 snapshots on
  // forks and 1 on threads, i.e. two workers' counters lost to a clean last-wins OVERWRITE —
  // valid JSON, no error, silently short numbers. (A truncated read is possible too, but the
  // overwrite is what actually happens.) The suffix is generated when this module first
  // initialises, which under isolation is once per test FILE rather than once per worker — that
  // is finer than it needs to be and is harmless, since the report sums.
  const workerId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  // Overridable so a test can point one run at a scratch directory instead of clobbering the
  // trace a developer is in the middle of reading.
  const flush = () => {
    const dir = resolveTraceDir(
      process.env.TESTPERF_TRACE_DIR,
      path.join(process.cwd(), '.test-perf/trace')
    );
    try {
      mkdirSync(dir, { recursive: true });
      const out: Record<string, Entry> = {};
      for (const [k, v] of stats)
        out[k] = { loads: v.loads, selfMs: +v.selfMs.toFixed(1), totalMs: +v.totalMs.toFixed(1) };
      writeFileSync(path.join(dir, snapshotFileName(workerId)), JSON.stringify(out));
    } catch (err) {
      // Never throw out of a flush — but never swallow it either. A silently unwritten snapshot is
      // precisely the failure this file exists to close, and `trace-report.mjs` cannot tell the
      // difference between "nothing was traced" and "every write failed".
      process.stderr.write(`[trace-setup] flush to ${dir} failed: ${String(err)}\n`);
    }
  };

  // The one that actually runs, and the reason this file changed. Registered once per tracer
  // initialisation — which under isolation is once per test FILE — it fires at the end of that
  // file, inside the worker, before the pool can kill it. Synchronous, because an async flush would
  // not complete.
  afterAll(flush);
  // Backstop for a worker torn down by a real `process.exit()` rather than a signal.
  process.on('exit', flush);
  // Backstop for a long run: vitest reuses a worker across files, so a worker killed mid-file
  // still leaves the last periodic snapshot behind. Overridable so a test can push it out of the
  // way and leave `afterAll` as the ONLY path that can produce a snapshot — otherwise a slow child
  // run satisfies the regression test through this timer whether or not the fix is present.
  // Validated, not coerced — see resolveIntervalMs. Every wrong answer here is a 1ms flush loop.
  const t = setInterval(flush, resolveIntervalMs(process.env.TESTPERF_TRACE_INTERVAL_MS));
  if (typeof t.unref === 'function') t.unref();
}

export {};
