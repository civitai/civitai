/**
 * Installs the module-execution counters used by `trace-config.mts` and flushes them on exit.
 *
 * Runs before the real setup file, so the counters exist by the time anything else is imported.
 * State hangs off `globalThis` deliberately: it has to survive the per-file module-registry reset
 * that isolation performs, or every file would report only its own modules and the per-worker
 * totals — the thing being measured — would be lost.
 */
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

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

  const flush = () => {
    const dir = path.join(process.cwd(), '.test-perf/trace');
    try {
      mkdirSync(dir, { recursive: true });
      const out: Record<string, Entry> = {};
      for (const [k, v] of stats)
        out[k] = { loads: v.loads, selfMs: +v.selfMs.toFixed(1), totalMs: +v.totalMs.toFixed(1) };
      writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(out));
    } catch {}
  };

  // `exit` only — an async flush would not complete, and vitest tears workers down abruptly.
  process.on('exit', flush);
  // Vitest reuses a worker across files, so also flush periodically: a worker killed rather than
  // exited still leaves the last snapshot behind.
  const t = setInterval(flush, 15000);
  if (typeof t.unref === 'function') t.unref();
}

export {};
