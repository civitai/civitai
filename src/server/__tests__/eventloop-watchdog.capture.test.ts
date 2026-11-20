import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCHDOG_WORKER_SOURCE, resolveCaptureConfig } from '~/server/eventloop-watchdog';
import { allowConnection } from '~/__tests__/network-guard';

const ENV_KEYS = [
  'EVENTLOOP_WATCHDOG_CAPTURE_ENABLED',
  'EVENTLOOP_WATCHDOG_CAPTURE_MS',
  'EVENTLOOP_WATCHDOG_CAPTURE_INTERVAL_US',
  'EVENTLOOP_WATCHDOG_CAPTURE_MAX_PER_HOUR',
  'EVENTLOOP_WATCHDOG_MAX_PROFILES_ON_DISK',
  'CPU_PROFILE_DIR',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('capture config', () => {
  it('is disarmed unless explicitly enabled, independently of the detector', async () => {
    // Detection is cheap and safe everywhere; capture opens an inspector and drives
    // CDP. They must be separate gates or enabling the watchdog silently enables the
    // expensive half.
    const { resolveCaptureConfig: resolve } = await import('~/server/eventloop-watchdog');
    expect(resolve().enabled).toBe(false);

    process.env.EVENTLOOP_WATCHDOG_CAPTURE_ENABLED = 'true';
    expect((await import('~/server/eventloop-watchdog')).resolveCaptureConfig().enabled).toBe(true);
  });
});

describe('starvation classifier', () => {
  // Busy helper threads, as on a production pod.
  const SPINNER = `
    const { workerData } = require('node:worker_threads');
    const until = Date.now() + workerData.ms;
    let sink = 0;
    while (Date.now() < until) sink += Math.sqrt(Math.random());
  `;

  const WORKER_POLL_MS = 25;

  async function runWedge(
    kind: 'starved' | 'executing',
    settleOn: Record<string, number>,
    backgroundThreads = 0
  ) {
    const sab = new SharedArrayBuffer(8);
    const beat = new BigInt64Array(sab);
    Atomics.store(beat, 0, BigInt(Date.now()));

    const worker = new Worker(WATCHDOG_WORKER_SOURCE, {
      eval: true,
      workerData: {
        sab,
        thresholdMs: 300,
        port: 0,
        token: 'classifier-test',
        heartbeatIntervalMs: 50,
        pollMs: WORKER_POLL_MS,
        cap: { ...resolveCaptureConfig(), enabled: false },
        starvedRatio: 0.2,
      },
    });

    const spinners = Array.from(
      { length: backgroundThreads },
      () => new Worker(SPINNER, { eval: true, workerData: { ms: 1800 } })
    );

    // A slow worker boot must not read as a first, spurious wedge.
    const beating = setInterval(() => Atomics.store(beat, 0, BigInt(Date.now())), WORKER_POLL_MS);
    let port: number;
    try {
      port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('never listened')), 10_000);
        worker.on('message', (m: { type?: string; port?: number }) => {
          if (m?.type === 'listening' && m.port) {
            clearTimeout(timer);
            resolve(m.port);
          }
        });
        worker.on('error', reject);
      });
      // The worker's own server: the guard does not see a listen in another thread.
      allowConnection('127.0.0.1', port);

      // The classifier returns null unless the CPU ring reaches back before the wedge.
      await new Promise((r) => setTimeout(r, WORKER_POLL_MS * 16));
    } finally {
      clearInterval(beating);
    }

    const until = Date.now() + 1500;
    if (kind === 'executing') {
      let sink = 0;
      while (Date.now() < until) sink += Math.sqrt(Math.random());
      void sink;
    } else {
      await new Promise((r) => setTimeout(r, 1500));
    }

    Atomics.store(beat, 0, BigInt(Date.now()));
    const body = await scrapeUntil(port, settleOn);
    await worker.terminate();
    await Promise.all(spinners.map((s) => s.terminate()));
    return body;
  }

  const read = (body: string, name: string) =>
    Number(
      body
        .split('\n')
        .find((l) => l.startsWith(`${name} `))
        ?.slice(name.length + 1)
    );

  async function scrapeUntil(port: number, settleOn: Record<string, number>) {
    const deadlineMs = 10_000;
    const deadline = Date.now() + deadlineMs;
    let body = '';
    for (;;) {
      body = await (await fetch(`http://127.0.0.1:${port}/metrics?token=classifier-test`)).text();
      if (Object.entries(settleOn).every(([name, value]) => read(body, name) === value)) {
        return body;
      }
      if (Date.now() >= deadline) {
        const wanted = Object.entries(settleOn)
          .map(([name, value]) => `${name} = ${value}`)
          .join(', ');
        const seen = body
          .split('\n')
          .filter(
            (l) =>
              l.startsWith('civitai_app_watchdog_wedge_kind_total') ||
              l.startsWith('civitai_app_watchdog_wedge_cpu_ratio_count') ||
              l.startsWith('civitai_app_watchdog_capture_total')
          )
          .join('\n  ');
        throw new Error(
          `watchdog metrics never settled: waited ${deadlineMs}ms for ${wanted}.\n` +
            `  last scrape:\n  ${seen}`
        );
      }
      await new Promise((r) => setTimeout(r, WORKER_POLL_MS));
    }
  }

  it('🔴 classifies a CPU-burning wedge as executing, and does not skip its capture', async () => {
    const body = await runWedge('executing', {
      'civitai_app_watchdog_wedge_kind_total{kind="executing"}': 1,
    });
    expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="executing"}')).toBe(1);
    expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="starved"}')).toBe(0);
    expect(read(body, 'civitai_app_watchdog_capture_total{result="skipped-starved"}')).toBe(0);
  }, 30_000);

  // A pod runs many busy helper threads, so a process-wide CPU clock reads every wedge as
  // executing. Linux-only: per-thread CPU comes from /proc/self/task.
  it.runIf(process.platform === 'linux')(
    '🔴 classifies an idle wedge as starved, and skips the capture, even while OTHER threads burn CPU',
    async () => {
      const body = await runWedge(
        'starved',
        {
          'civitai_app_watchdog_wedge_kind_total{kind="starved"}': 1,
          'civitai_app_watchdog_capture_total{result="skipped-starved"}': 1,
        },
        4
      );
      expect(read(body, 'civitai_app_watchdog_cpu_source{source="main-thread"}')).toBe(1);
      expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="starved"}')).toBe(1);
      expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="executing"}')).toBe(0);
      expect(read(body, 'civitai_app_watchdog_capture_total{result="skipped-starved"}')).toBe(1);
    },
    30_000
  );
});
