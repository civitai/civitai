import fs from 'fs';
import os from 'os';
import path from 'path';
import client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildThreadCpuCounter,
  parseTaskStat,
  threadGroup,
  THREAD_CPU_METRIC,
  THREAD_GROUPS,
} from '~/server/prom/thread-cpu.metrics';

const MAIN = 4242;

/** A `/proc/<pid>/task/<tid>/stat` line with the given name and utime/stime (in ticks). */
const statLine = (tid: number, comm: string, utime: number, stime: number) =>
  `${tid} (${comm}) S 1 ${MAIN} ${MAIN} 0 -1 4194560 100 0 0 0 ${utime} ${stime} 0 0 20 0 30 0 100 0 0\n`;

let taskDir: string;

function writeThread(tid: number, comm: string, utime: number, stime: number) {
  fs.mkdirSync(path.join(taskDir, String(tid)), { recursive: true });
  fs.writeFileSync(path.join(taskDir, String(tid), 'stat'), statLine(tid, comm, utime, stime));
}

async function read(registry: client.Registry): Promise<Record<string, number>> {
  const metric = registry.getSingleMetric(THREAD_CPU_METRIC) as client.Counter<string>;
  const { values } = await metric.get();
  return Object.fromEntries(values.map((v) => [v.labels.thread_group, v.value]));
}

beforeEach(() => {
  taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-cpu-'));
});
afterEach(() => {
  fs.rmSync(taskDir, { recursive: true, force: true });
});

describe('parseTaskStat', () => {
  it('reads utime + stime after the LAST `)`, so a name with spaces or parens cannot shift fields', () => {
    expect(parseTaskStat(statLine(7, 'V8 DefaultWorke', 30, 12))).toEqual({
      comm: 'V8 DefaultWorke',
      ticks: 42,
    });
    expect(parseTaskStat(statLine(7, 'a) b (c', 5, 6))).toEqual({ comm: 'a) b (c', ticks: 11 });
  });

  it('rejects a truncated line instead of yielding NaN', () => {
    expect(parseTaskStat('7 (node) S 1 2')).toBeNull();
    expect(parseTaskStat('garbage')).toBeNull();
  });
});

describe('threadGroup', () => {
  it.each([
    ['node', MAIN, 'main'],
    ['next-server (v1', MAIN, 'main'],
    ['V8Worker', 2, 'v8_worker'],
    ['V8 DefaultWorke', 2, 'v8_worker'],
    ['libuv-worker', 3, 'libuv_worker'],
    ['tokio-runtime-w', 4, 'prisma_engine'],
    ['node', 5, 'other'],
    ['HeapHelper', 6, 'other'],
  ] as const)('%s (tid %d) -> %s', (comm, tid, group) => {
    expect(threadGroup(comm, tid, MAIN)).toBe(group);
  });
});

describe(THREAD_CPU_METRIC, () => {
  it('sums each group from a fixture /proc tree, in seconds', async () => {
    writeThread(MAIN, 'node', 500, 100);
    writeThread(MAIN + 1, 'V8Worker', 70, 30);
    writeThread(MAIN + 2, 'V8 DefaultWorke', 50, 0);
    writeThread(MAIN + 3, 'libuv-worker', 20, 5);
    writeThread(MAIN + 4, 'tokio-runtime-w', 300, 100);
    writeThread(MAIN + 5, 'inspector', 1, 2);
    const registry = new client.Registry();
    buildThreadCpuCounter({ registry, taskDir, mainTid: MAIN, platform: 'linux' });

    expect(await read(registry)).toEqual({
      main: 6,
      v8_worker: 1.5,
      libuv_worker: 0.25,
      prisma_engine: 4,
      other: 0.03,
    });
  });

  it('stays monotonic when a thread exits, and counts a new thread from zero', async () => {
    writeThread(MAIN, 'node', 100, 0);
    writeThread(MAIN + 1, 'V8Worker', 200, 0);
    const registry = new client.Registry();
    buildThreadCpuCounter({ registry, taskDir, mainTid: MAIN, platform: 'linux' });
    expect((await read(registry)).v8_worker).toBe(2);

    // The first worker exits; a second appears with 50 ticks. Summing the live threads would
    // read 0.5 here — a drop that rate() turns into a counter-reset spike.
    fs.rmSync(path.join(taskDir, String(MAIN + 1)), { recursive: true });
    writeThread(MAIN + 2, 'V8Worker', 50, 0);
    writeThread(MAIN, 'node', 150, 0);
    const after = await read(registry);
    expect(after.v8_worker).toBe(2.5);
    expect(after.main).toBe(1.5);
  });

  it('counts a reused tid with fewer ticks from zero instead of throwing on a negative increment', async () => {
    writeThread(MAIN, 'node', 0, 0);
    writeThread(MAIN + 1, 'libuv-worker', 500, 0);
    const registry = new client.Registry();
    buildThreadCpuCounter({ registry, taskDir, mainTid: MAIN, platform: 'linux' });
    expect((await read(registry)).libuv_worker).toBe(5);

    writeThread(MAIN + 1, 'libuv-worker', 30, 0);
    expect((await read(registry)).libuv_worker).toBe(5.3);
  });

  it('keeps a fixed label set however many distinct thread names exist', async () => {
    writeThread(MAIN, 'node', 1, 0);
    for (let i = 1; i <= 200; i++) writeThread(MAIN + i, `worker-${i}`, 1, 0);
    const registry = new client.Registry();
    buildThreadCpuCounter({ registry, taskDir, mainTid: MAIN, platform: 'linux' });
    const groups = Object.keys(await read(registry)).sort();
    expect(groups).toEqual([...THREAD_GROUPS].sort());
    expect((await read(registry)).other).toBe(2);
  });

  it('exports nothing off Linux, even when a readable tree exists', async () => {
    writeThread(MAIN, 'node', 100, 0);
    const registry = new client.Registry();
    buildThreadCpuCounter({ registry, taskDir, mainTid: MAIN, platform: 'darwin' });
    expect(await read(registry)).toEqual({});
  });

  it('exports nothing, and does not throw, when the task directory is missing', async () => {
    const registry = new client.Registry();
    buildThreadCpuCounter({
      registry,
      taskDir: path.join(taskDir, 'absent'),
      mainTid: MAIN,
      platform: 'linux',
    });
    await expect(registry.metrics()).resolves.toContain(THREAD_CPU_METRIC);
    expect(await read(registry)).toEqual({});
  });

  it.runIf(process.platform === 'linux')(
    'reads this process from the real /proc (positive control for the fixture format)',
    async () => {
      const registry = new client.Registry();
      buildThreadCpuCounter({ registry });
      const end = Date.now() + 50;
      while (Date.now() < end); // burn main-thread CPU so the reading cannot be 0
      const values = await read(registry);
      expect(Object.keys(values).sort()).toEqual([...THREAD_GROUPS].sort());
      expect(values.main).toBeGreaterThan(0);
    }
  );
});
