/**
 * Installs the module-execution counters used by `trace-config.mts` and flushes them.
 *
 * Runs before the real setup file, so the counters exist by the time anything else is imported.
 * State hangs off `globalThis` deliberately: it has to survive the per-file module-registry reset
 * that isolation performs, or every file would report only its own modules and the per-worker
 * totals — the thing being measured — would be lost.
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
import { snapshotFileName } from './trace-snapshot-name';

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
  // overwrite is what actually happens.) The suffix is generated once per worker, when this
  // module first initialises.
  const workerId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  // Overridable so a test can point one run at a scratch directory instead of clobbering the
  // trace a developer is in the middle of reading.
  const flush = () => {
    const dir = process.env.TESTPERF_TRACE_DIR ?? path.join(process.cwd(), '.test-perf/trace');
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

  // The one that actually runs, and the reason this file changed. Registered once per worker (this
  // whole block is behind a `!g.__modTrace` guard on a fresh `globalThis`), it fires once per test
  // file — inside the worker, before the pool can kill it. Synchronous, because an async flush
  // would not complete.
  afterAll(flush);
  // Backstop for a worker torn down by a real `process.exit()` rather than a signal.
  process.on('exit', flush);
  // Backstop for a long run: vitest reuses a worker across files, so a worker killed mid-file
  // still leaves the last periodic snapshot behind. Overridable so a test can push it out of the
  // way and leave `afterAll` as the ONLY path that can produce a snapshot — otherwise a slow child
  // run satisfies the regression test through this timer whether or not the fix is present.
  // Validate rather than coerce: `Number('abc')` is NaN, `Number('')` is 0 (and `??` does not
  // catch an empty string, so `export TESTPERF_TRACE_INTERVAL_MS=` reaches here), and Node clamps
  // NaN / 0 / negatives to a 1ms timer — a synchronous whole-snapshot write ~900x/second from
  // inside every worker, which charges its own cost to the measurement being taken. Same idiom as
  // VITEST_MAX_WORKERS in vitest.config.mts.
  const envInterval = Number.parseInt(process.env.TESTPERF_TRACE_INTERVAL_MS ?? '', 10);
  const intervalMs = Number.isFinite(envInterval) && envInterval > 0 ? envInterval : 15000;
  const t = setInterval(flush, intervalMs);
  if (typeof t.unref === 'function') t.unref();
}

export {};
