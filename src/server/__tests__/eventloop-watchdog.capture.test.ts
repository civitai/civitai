import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCHDOG_WORKER_SOURCE, resolveCaptureConfig } from '~/server/eventloop-watchdog';

// The capture half of the worker. Like the detector suite, this drives the REAL
// inlined source rather than a TypeScript stand-in, because the source is neither
// type-checked nor linted and that is the only way it gets exercised.

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

  it('clamps duration and sampling interval rather than trusting them', () => {
    process.env.EVENTLOOP_WATCHDOG_CAPTURE_MS = '999999';
    expect(resolveCaptureConfig().captureMs).toBe(30_000);
    process.env.EVENTLOOP_WATCHDOG_CAPTURE_MS = '1';
    expect(resolveCaptureConfig().captureMs).toBe(1000);

    // 100Hz default. The old in-process path sampled at 1kHz and produced 41-46MB
    // profiles on SSR, which is why the default is not the V8 default.
    delete process.env.EVENTLOOP_WATCHDOG_CAPTURE_INTERVAL_US;
    expect(resolveCaptureConfig().samplingIntervalUs).toBe(10_000);
  });

  it('defaults the capture dir to the harvester PROFILE_DIR and carries pool/pod/imageTag', () => {
    // 🔴 /tmp is the cpu-profile-harvester CronJob's PROFILE_DIR default. If these two
    // drift the app writes happily, the sweep finds nothing, and both sides look fine.
    const cfg = resolveCaptureConfig();
    expect(cfg.dir).toBe('/tmp');
    expect(cfg).toMatchObject({
      pool: expect.any(String),
      pod: expect.any(String),
      imageTag: expect.any(String),
    });
  });

  it('bounds the on-disk backlog, and clamps a hostile value', () => {
    // maxPerHour bounds the RATE; this bounds the BACKLOG, which is what fills /tmp
    // when the harvester stops. A pod that fills its disk takes itself out.
    expect(resolveCaptureConfig().maxFilesOnDisk).toBe(3);
    process.env.EVENTLOOP_WATCHDOG_MAX_PROFILES_ON_DISK = '9999';
    expect(resolveCaptureConfig().maxFilesOnDisk).toBe(20);
  });
});

describe('starvation classifier', () => {
  // The dominant wedge class on this fleet is the main thread being descheduled, not
  // looping — sliced production captures showed no JS executing during the wedge,
  // against 2.28s/s of runqueue wait. A profiler cannot see that. CPU-time against
  // wall-time can, and this proves the two classes actually separate rather than that
  // the code runs.

  // Spin CPU on OTHER threads for ms, the way a real pod's 32 Prisma tokio workers,
  // 4 V8Workers and 16 libuv workers do. This is the whole difference between a
  // preview pod and production, and the reason the process-wide clock failed there.
  const SPINNER = `
    const { workerData } = require('node:worker_threads');
    const until = Date.now() + workerData.ms;
    let sink = 0;
    while (Date.now() < until) sink += Math.sqrt(Math.random());
  `;

  // The worker's own sampling cadence. Named so the ring warmup below reads as a
  // multiple of it rather than as one more bare millisecond guess.
  const WORKER_POLL_MS = 25;

  /**
   * @param settleOn series the wedge must make true before the body is read. See
   *   scrapeUntil — this is WHEN to look, never WHAT to assert.
   */
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

    // Beat from before the worker exists until the wedge starts, so the only stale-beat
    // window in the run is the one the test opens deliberately, and a slow worker boot
    // cannot be read as a first, spurious wedge.
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

      // 🔴 Let the worker's CPU ring accumulate samples that PRE-DATE the wedge. The
      // classifier reads main-thread CPU over [wedge start, detection] and returns null
      // — no classification, and at detection no skipped-starved tally — when the ring
      // cannot reach back that far. The ring starts when the worker boots, so without
      // this warmup the entire margin is worker startup against the 300ms threshold:
      // ~20ms boot idle, and the capture gate stops being recorded once boot slips past
      // ~90ms. That is #3773 — the wedge still classified starved, only the
      // detection-time counter went missing. Production never sees it: the worker starts
      // with the process and wedges arrive minutes later, ring long since full.
      await new Promise((r) => setTimeout(r, WORKER_POLL_MS * 16));
    } finally {
      clearInterval(beating);
    }

    // Withhold beats for 1.5s. In the executing case the MAIN thread burns CPU
    // throughout, which is what the classifier has to notice; in the starved case it
    // does nothing, standing in for a descheduled thread.
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

  // Poll for the counters the wedge has to move instead of sleeping a fixed interval
  // and hoping. Every series here is written by the worker's own poll loop, so "has it
  // landed yet" is a question about a loaded runner's scheduling, not a constant — a
  // fixed 250ms guess left ~65ms of slack against worker startup and went red on CI
  // (#3773). This changes WHEN the body is read, never what is asserted about it: an
  // expectation that never becomes true is not waited away, it fails here with what it
  // wanted and what it last saw.
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

  it('🔴 classifies a CPU-burning wedge as executing', async () => {
    const body = await runWedge('executing', {
      'civitai_app_watchdog_wedge_kind_total{kind="executing"}': 1,
    });
    expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="executing"}')).toBe(1);
    expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="starved"}')).toBe(0);
  }, 30_000);

  it('🔴 classifies an idle wedge as starved, and skips the capture', async () => {
    const body = await runWedge('starved', {
      'civitai_app_watchdog_wedge_kind_total{kind="starved"}': 1,
      'civitai_app_watchdog_capture_total{result="skipped-starved"}': 1,
    });
    expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="starved"}')).toBe(1);
    expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="executing"}')).toBe(0);
    // The whole point of the gate: a starved wedge has nothing to sample, so no
    // profile is taken and no idle artefact reaches the corpus.
    expect(read(body, 'civitai_app_watchdog_capture_total{result="skipped-starved"}')).toBe(1);
  }, 30_000);

  // 🔴 THE REGRESSION TEST. Everything above passes under BOTH implementations,
  // because a vitest process has no busy helper threads — which is exactly why the
  // process-wide clock shipped and then failed in production, where every pod runs ~58
  // threads. Measured on dp-prod 2026-08-09: 154 wedges, mean ratio 1.20, 152 of them
  // above 1.0, and the starved bucket structurally unreachable. Under the old
  // process.cpuUsage() reading this case classifies EXECUTING and fails.
  //
  // Linux-only by construction: /proc/self/task is where per-thread CPU comes from, and
  // off Linux the worker deliberately falls back to the process-wide clock, which
  // cannot pass this. Asserting the source label rather than skipping silently, so a
  // fleet running the fallback is visible rather than assumed.
  it.runIf(process.platform === 'linux')(
    '🔴 classifies a wedge as starved even while OTHER threads burn CPU',
    async () => {
      const body = await runWedge(
        'starved',
        { 'civitai_app_watchdog_wedge_kind_total{kind="starved"}': 1 },
        4
      );
      expect(read(body, 'civitai_app_watchdog_cpu_source{source="main-thread"}')).toBe(1);
      expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="starved"}')).toBe(1);
      expect(read(body, 'civitai_app_watchdog_wedge_kind_total{kind="executing"}')).toBe(0);
    },
    30_000
  );

  it('exposes the ratio distribution and the threshold echo', async () => {
    // A gauge of the last value could not answer "where do starved wedges actually
    // sit" — the continuous profiler adds a CPU floor, so that has to be readable
    // rather than assumed.
    const body = await runWedge('starved', {
      civitai_app_watchdog_wedge_cpu_ratio_count: 1,
    });
    expect(body).toContain('civitai_app_watchdog_wedge_cpu_ratio_bucket{le="0.05"}');
    expect(body).toContain('civitai_app_watchdog_wedge_cpu_ratio_count 1');
    expect(read(body, 'civitai_app_watchdog_starved_ratio_threshold')).toBe(0.2);
  }, 30_000);
});

describe('capture metrics', () => {
  it('exposes every capture series even before anything is captured', async () => {
    // Absent and zero mean different things to an alert. A pool with capture armed
    // and nothing yet captured must read 0, not no-series.
    const sab = new SharedArrayBuffer(8);
    Atomics.store(new BigInt64Array(sab), 0, BigInt(Date.now()));

    const worker = new Worker(WATCHDOG_WORKER_SOURCE, {
      eval: true,
      workerData: {
        sab,
        thresholdMs: 1000,
        port: 0,
        // Non-empty: the worker fails closed and exits 78 without a token, so an empty
        // one here would never reach the metrics path at all.
        token: 'capture-test-token',
        heartbeatIntervalMs: 100,
        pollMs: 50,
        cap: { ...resolveCaptureConfig(), enabled: false },
      },
    });

    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never listened')), 10_000);
      worker.on('message', (m: { type?: string; port?: number }) => {
        if (m?.type === 'listening' && m.port) {
          clearTimeout(timer);
          resolve(m.port);
        }
      });
      worker.on('error', reject);
    });

    const body = await (
      await fetch(`http://127.0.0.1:${port}/metrics?token=capture-test-token`)
    ).text();
    await worker.terminate();

    for (const series of [
      'civitai_app_watchdog_capture_total{result="ok"} 0',
      'civitai_app_watchdog_capture_total{result="error"} 0',
      'civitai_app_watchdog_capture_total{result="skipped-backoff"} 0',
      'civitai_app_watchdog_capture_total{result="skipped-hourly-cap"} 0',
      'civitai_app_watchdog_profile_write_total{result="ok"} 0',
      'civitai_app_watchdog_profile_write_total{result="skipped-disk-cap"} 0',
      'civitai_app_watchdog_profile_write_bytes_total 0',
      // Value, not asserted: the default dir is the real /tmp and a stray file there
      // would make this flake. Presence is the contract.
      'civitai_app_watchdog_profiles_on_disk ',
      'civitai_app_watchdog_last_capture_timestamp_seconds 0',
      // Which clock is feeding the classifier must be readable, not inferred. A fleet
      // silently on the fallback reports every wedge as executing and looks healthy.
      'civitai_app_watchdog_cpu_source{source="main-thread"}',
    ]) {
      expect(body, series).toContain(series);
    }
  });
});
