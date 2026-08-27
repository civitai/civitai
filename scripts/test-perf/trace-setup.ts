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

  // Overridable so a test can point one run at a scratch directory instead of clobbering the
  // trace a developer is in the middle of reading.
  const flush = () => {
    const dir = process.env.TESTPERF_TRACE_DIR ?? path.join(process.cwd(), '.test-perf/trace');
    try {
      mkdirSync(dir, { recursive: true });
      const out: Record<string, Entry> = {};
      for (const [k, v] of stats)
        out[k] = { loads: v.loads, selfMs: +v.selfMs.toFixed(1), totalMs: +v.totalMs.toFixed(1) };
      writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(out));
    } catch {}
  };

  // The one that actually runs. Fires per test file, inside the worker, before the pool can kill
  // it — so a snapshot exists no matter how the worker dies afterwards. Synchronous, because an
  // async flush would not complete.
  afterAll(flush);
  // Backstop for a worker torn down by a real `process.exit()` rather than a signal.
  process.on('exit', flush);
  // Backstop for a long run: vitest reuses a worker across files, so a worker killed mid-file
  // still leaves the last periodic snapshot behind.
  const t = setInterval(flush, 15000);
  if (typeof t.unref === 'function') t.unref();
}

export {};
