import fs from 'fs';
import path from 'path';
import client from 'prom-client';
import type { Registry } from 'prom-client';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';

export const THREAD_CPU_METRIC = PROM_PREFIX + 'thread_cpu_seconds_total';

export const THREAD_GROUPS = [
  'main',
  'v8_worker',
  'libuv_worker',
  'prisma_engine',
  'other',
] as const;
export type ThreadGroup = (typeof THREAD_GROUPS)[number];

// USER_HZ: the unit of utime/stime in /proc/<pid>/task/<tid>/stat. Fixed at 100 by the Linux
// userspace ABI on every architecture we run on.
const CLOCK_TICKS_PER_SECOND = 100;

/** `comm` is the kernel's thread name, truncated to 15 bytes (`V8 DefaultWorke`). */
export function threadGroup(comm: string, tid: number, mainTid: number): ThreadGroup {
  if (tid === mainTid) return 'main';
  if (comm.startsWith('V8')) return 'v8_worker';
  if (comm.startsWith('libuv-worker')) return 'libuv_worker';
  if (comm.startsWith('tokio-runtime')) return 'prisma_engine';
  return 'other';
}

/**
 * utime + stime in clock ticks, and the thread name. `comm` sits in parentheses and may itself
 * contain spaces or `)`, so fields are counted from the LAST `)`.
 */
export function parseTaskStat(content: string): { comm: string; ticks: number } | null {
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  // Fields after `comm` start at field 3 (state); utime and stime are fields 14 and 15.
  const fields = content.slice(close + 2).split(' ');
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { comm: content.slice(open + 1, close), ticks: utime + stime };
}

export type ThreadSample = { tid: number; comm: string; ticks: number };

export function readThreadSamples(taskDir: string): ThreadSample[] {
  const samples: ThreadSample[] = [];
  for (const entry of fs.readdirSync(taskDir)) {
    const tid = Number(entry);
    if (!Number.isInteger(tid)) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(path.join(taskDir, entry, 'stat'), 'utf8');
    } catch {
      continue; // the thread exited between readdir and read
    }
    const parsed = parseTaskStat(stat);
    if (parsed) samples.push({ tid, ...parsed });
  }
  return samples;
}

/**
 * Turns per-thread cumulative ticks into per-group increments. Summing the live threads directly
 * would make the group total DROP whenever a thread exits, which `rate()` reads as a counter reset
 * and turns into a spike; carrying each thread's last value forward keeps every group monotonic.
 */
export function createThreadCpuAccumulator() {
  let last = new Map<number, number>();
  return function update(samples: ThreadSample[], mainTid: number) {
    const deltas = Object.fromEntries(THREAD_GROUPS.map((g) => [g, 0])) as Record<
      ThreadGroup,
      number
    >;
    const next = new Map<number, number>();
    for (const { tid, comm, ticks } of samples) {
      const prev = last.get(tid);
      // No previous value, or a smaller one (the tid was reused): count from zero.
      const delta = prev === undefined || ticks < prev ? ticks : ticks - prev;
      deltas[threadGroup(comm, tid, mainTid)] += delta;
      next.set(tid, ticks);
    }
    last = next;
    return deltas;
  };
}

export function buildThreadCpuCounter({
  registry,
  taskDir = '/proc/self/task',
  mainTid = process.pid,
  platform = process.platform,
}: {
  registry: Registry;
  taskDir?: string;
  mainTid?: number;
  platform?: NodeJS.Platform;
}) {
  const update = createThreadCpuAccumulator();
  return new client.Counter({
    name: THREAD_CPU_METRIC,
    help: 'CPU seconds (user + system) consumed by this process, by thread group',
    labelNames: ['thread_group'] as const,
    registers: [registry],
    // Read on scrape rather than on a timer, so it costs nothing between scrapes.
    collect() {
      if (platform !== 'linux') return;
      let samples: ThreadSample[];
      try {
        samples = readThreadSamples(taskDir);
      } catch {
        return; // no procfs: export nothing rather than a misleading zero
      }
      const deltas = update(samples, mainTid);
      for (const group of THREAD_GROUPS) {
        this.inc({ thread_group: group }, deltas[group] / CLOCK_TICKS_PER_SECOND);
      }
    },
  });
}

export function ensureRegisterThreadCpuMetrics() {
  return registerInstrumentationMetric(THREAD_CPU_METRIC, () =>
    buildThreadCpuCounter({ registry: instrumentationRegistry })
  );
}
