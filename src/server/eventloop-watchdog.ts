// Off-loop event-loop wedge detector.
//
// WHY: every existing way we watch the event loop runs ON the event loop, so all
// of them are blind to the thing they are named after. The `loopstall-*`
// self-trigger in cpu-profiler.ts reads its lag histogram from a setInterval that
// cannot fire while the loop is pinned, and `/api/metrics` is served by the same
// pinned loop, so a wedged pod reports nothing at all. Measured over six hours, the
// scraped event-loop-lag metric peaked several seconds below the shortest real wedge
// in the same window — wedges run minutes, and the scrape cannot report during one.
//
// This module puts the observer somewhere the wedge cannot reach it. The main
// thread stores a millisecond timestamp into a SharedArrayBuffer; a worker thread
// with its own event loop reads that timestamp and serves its own metrics port.
// A wedged main thread stops updating the timestamp, and the worker — which is
// still scheduling normally — reports the staleness.
//
// WHY A TIMER AND NOT A PER-TICK HOOK: a wedge IS "no timer has fired in N ms", so
// a per-tick hook detects nothing a timer does not. The only way to hook every tick
// is async_hooks, which is the exact per-resource cost instrumentation.node.ts
// removed from OTEL and that eventloop-longtask.ts gates behind an opt-in tier.
// Measured: Atomics.store is 7.8-9.0ns, but BigInt(Date.now()) makes the pair
// 96.5ns, so the timestamp — not the store — would be the per-tick cost. At a 100ms
// beat the whole mechanism is ~1us/s.
//
// WHY THE WORKER CANNOT SERVE /api/metrics: that route concatenates the default
// registry, the cross-graph instrumentationRegistry, and two async Prisma
// $metrics.prometheus() calls, several of them collect()-based gauges that compute
// their values at scrape time on the main thread. None of it is reachable from
// another thread. The worker therefore serves ONLY worker-owned metrics — which are
// also the only ones that are still true during a wedge.
//
// WHY THE WORKER SOURCE IS AN INLINE STRING: next.config.mjs uses
// output:'standalone', which traces files with @vercel/nft. The config already
// carries three outputFileTracingIncludes workarounds for files nft could not
// follow, one of them recording that /api/og broke this way and became the dominant
// 500 source. A `new Worker(new URL('./file.js', import.meta.url))` from the
// Turbopack instrumentation graph is the same failure class, and the failure is the
// silent kind: the spawn throws, the arm-time catch below (correctly) swallows it,
// and an absent watchdog reads exactly like a healthy pod. `eval: true` has no
// tracing surface at all. The tradeoff is that the source is not type-checked, so
// eventloop-watchdog.worker.test.ts spawns it for real.
//
// DISARMED by default, like every other profiler in this directory. Nothing is
// installed unless EVENTLOOP_WATCHDOG_ENABLED === 'true'.
//
// Server-side (nodejs runtime) only. Never imported on the edge/client.

import { Worker } from 'node:worker_threads';
import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '~/server/prom/client';

const PROM_PREFIX = 'civitai_app_';

const DEFAULT_THRESHOLD_MS = 1000;
// Floor, not a default. A threshold near the noise level fires on ordinary GC:
// measured baseline loop lag already reaches multiple seconds at max, and real
// wedges last minutes, so sub-second detection latency buys nothing worth the false
// positives.
const MIN_THRESHOLD_MS = 250;

const DEFAULT_HEARTBEAT_MS = 100;
const MIN_HEARTBEAT_MS = 20;
const MAX_HEARTBEAT_MS = 1000;

const DEFAULT_PORT = 9099;
const DEFAULT_POLL_MS = 50;

// A wedge is declared after `threshold / beat` missed beats, so the two settings are
// only independently meaningful while that quotient is comfortably above 1. At 2x —
// reachable with the legal pair threshold=250, beat=100 — 2.5 missed beats declares a
// wedge, which scheduler jitter alone can produce on a node at 98-99% of allocatable
// CPU. Both values would be individually legal and their ratio legal, and the pod
// would report a rolling wedge that is entirely an artifact of its own config.
const MIN_THRESHOLD_BEAT_RATIO = 3;

/**
 * Resolved once at module load so `liveness-heartbeat` can branch on a constant.
 * Every other gate in this directory (pyroscope, cpu-profiler, eventloop-longtask)
 * reads its env once at load for the same reason.
 */
export const watchdogArmed = process.env.EVENTLOOP_WATCHDOG_ENABLED === 'true';

// 8 bytes, allocated unconditionally. Cheaper than branching on `watchdogArmed` at
// every call site, and it keeps recordWatchdogHeartbeat() free of a null check.
const heartbeatBuffer = new SharedArrayBuffer(8);
const heartbeat = new BigInt64Array(heartbeatBuffer);

export function recordWatchdogHeartbeat(nowMs: number = Date.now()): void {
  Atomics.store(heartbeat, 0, BigInt(nowMs));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveWatchdogThresholdMs(): number {
  const parsed = parsePositiveInt(process.env.EVENTLOOP_WATCHDOG_THRESHOLD_MS);
  return Math.max(parsed ?? DEFAULT_THRESHOLD_MS, MIN_THRESHOLD_MS);
}

/**
 * EFFECTIVE beat interval — the tick rate liveness-heartbeat actually runs at, the
 * resolution of every wedge duration the worker reports, and the value echoed as
 * `civitai_app_watchdog_heartbeat_interval_ms`. Echoing the requested value while
 * running a different one would make the config echo a lying metric, which is worse
 * than a missing one because it survives inspection.
 *
 * Enforces MIN_THRESHOLD_BEAT_RATIO by lowering the BEAT, never by raising the
 * threshold. The threshold is the operator's stated intent — the number that defines
 * what "wedged" means on this pod — so moving it silently would change what the pod
 * detects while the config still claims otherwise. The beat is an implementation
 * detail nobody tunes deliberately. `threshold / 3` is 83ms even at the 250ms
 * threshold floor, so this always has room above MIN_HEARTBEAT_MS and can never fail
 * to satisfy the ratio.
 */
export function resolveWatchdogHeartbeatMs(): number {
  const parsed = parsePositiveInt(process.env.EVENTLOOP_WATCHDOG_HEARTBEAT_MS);
  const configured = clamp(parsed ?? DEFAULT_HEARTBEAT_MS, MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS);
  const ratioCeiling = Math.floor(resolveWatchdogThresholdMs() / MIN_THRESHOLD_BEAT_RATIO);
  return clamp(Math.min(configured, ratioCeiling), MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS);
}

export function resolveWatchdogPort(): number {
  return parsePositiveInt(process.env.WATCHDOG_METRICS_PORT) ?? DEFAULT_PORT;
}

/**
 * Paired with the worker-served `civitai_app_watchdog_up`: this one says the main
 * thread spawned the worker, that one says the worker is alive. Neither alone can
 * tell "the watchdog is absent" from "no wedges occurred", which is the failure mode
 * the inline-source note above describes. Together they separate five states:
 *
 *                                 watchdog_up   worker_started
 *   healthy                            1              1
 *   MAIN THREAD WEDGED                 1           absent   (main can't serve /api/metrics)
 *   worker died after starting     absent             1
 *   worker never spawned (threw)   absent             0
 *   pod gone                       absent          absent
 *
 * Registered lazily, INSIDE the arm path, so a disarmed pod reports the series as
 * absent rather than 0 — prom-client would otherwise export a never-set gauge as 0,
 * making an un-enabled pool indistinguishable from a real arm failure and turning the
 * `== 0` alert into a false page on every pool we have not enabled yet.
 * `registerInstrumentationMetric` is get-or-create, so repeated calls are safe.
 */
function workerStartedGauge() {
  return registerInstrumentationMetric(
    PROM_PREFIX + 'watchdog_worker_started',
    () =>
      new client.Gauge({
        name: PROM_PREFIX + 'watchdog_worker_started',
        help: 'Whether the main thread successfully spawned the event-loop watchdog worker (1) or tried and failed (0). Absent means either the watchdog is disarmed on this pod or the main thread cannot serve /api/metrics — compare against the worker-served civitai_app_watchdog_up to tell those apart.',
        registers: [instrumentationRegistry],
      })
  );
}

/**
 * The worker runs as CommonJS (`eval: true` does not imply ESM) and imports nothing
 * but node: builtins — no prom-client, so there is no bare-specifier resolution to
 * go wrong inside an eval'd worker in the standalone image. The Prometheus text is
 * hand-formatted for the same reason.
 */
export const WATCHDOG_WORKER_SOURCE = String.raw`
const { workerData, parentPort } = require('node:worker_threads');
const http = require('node:http');
const crypto = require('node:crypto');

const { sab, thresholdMs, port, token, heartbeatIntervalMs, pollMs } = workerData;
const beat = new BigInt64Array(sab);

const BUCKETS = [1, 2, 5, 10, 30, 60, 120, 300, 600];
const bucketCounts = new Array(BUCKETS.length).fill(0);
let wedgeCount = 0;
let wedgeSumSeconds = 0;
let longestSeconds = 0;
// Epoch ms of the last beat before the current wedge, or 0 when healthy.
let wedgeStartedAt = 0;
const startedAt = Date.now();

function lastBeatMs() {
  return Number(Atomics.load(beat, 0));
}

function observeWedge(seconds) {
  wedgeCount++;
  wedgeSumSeconds += seconds;
  if (seconds > longestSeconds) longestSeconds = seconds;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (seconds <= BUCKETS[i]) bucketCounts[i]++;
  }
}

setInterval(function () {
  const now = Date.now();
  const lastBeat = lastBeatMs();
  const age = now - lastBeat;
  if (wedgeStartedAt === 0) {
    // Date the wedge from the last beat, not from detection, so the reported
    // duration does not silently exclude the threshold.
    if (age >= thresholdMs) wedgeStartedAt = lastBeat;
  } else if (age < thresholdMs) {
    observeWedge((now - wedgeStartedAt) / 1000);
    wedgeStartedAt = 0;
  }
}, pollMs).unref();

function render() {
  const now = Date.now();
  const age = now - lastBeatMs();
  const wedged = wedgeStartedAt === 0 ? 0 : 1;
  const current = wedgeStartedAt === 0 ? 0 : (now - wedgeStartedAt) / 1000;
  const out = [];
  function gauge(name, help, value) {
    out.push('# HELP ' + name + ' ' + help);
    out.push('# TYPE ' + name + ' gauge');
    out.push(name + ' ' + value);
  }
  gauge('civitai_app_watchdog_up', 'Event-loop watchdog worker is running and serving. Absence of this series is the signal that the watchdog is not running.', 1);
  gauge('civitai_app_watchdog_heartbeat_age_ms', 'Milliseconds since the main thread last wrote the shared-memory heartbeat. Grows without bound while the loop is wedged.', age);
  gauge('civitai_app_watchdog_wedged', 'Whether the main-thread event loop is currently considered wedged (1) or not (0).', wedged);
  gauge('civitai_app_watchdog_current_wedge_seconds', 'Duration of the IN-PROGRESS wedge, 0 when healthy. The duration histogram only observes on recovery, so this is the only series that moves during a live wedge or if the pod is killed mid-wedge.', current);
  gauge('civitai_app_watchdog_wedge_longest_seconds', 'Longest completed wedge observed in this process lifetime, seconds.', longestSeconds);
  gauge('civitai_app_watchdog_started_timestamp_seconds', 'Unix timestamp at which the watchdog worker started.', Math.floor(startedAt / 1000));
  gauge('civitai_app_watchdog_threshold_ms', 'Configured heartbeat-staleness threshold for declaring a wedge, ms.', thresholdMs);
  gauge('civitai_app_watchdog_heartbeat_interval_ms', 'EFFECTIVE main-thread heartbeat interval, ms — the value actually in use after the threshold/beat ratio clamp, which may be lower than the configured one.', heartbeatIntervalMs);

  out.push('# HELP civitai_app_watchdog_wedge_total Total completed event-loop wedges detected off-loop.');
  out.push('# TYPE civitai_app_watchdog_wedge_total counter');
  out.push('civitai_app_watchdog_wedge_total ' + wedgeCount);

  out.push('# HELP civitai_app_watchdog_wedge_duration_seconds Completed event-loop wedge durations, seconds. Observed on RECOVERY only.');
  out.push('# TYPE civitai_app_watchdog_wedge_duration_seconds histogram');
  for (let i = 0; i < BUCKETS.length; i++) {
    out.push('civitai_app_watchdog_wedge_duration_seconds_bucket{le="' + BUCKETS[i] + '"} ' + bucketCounts[i]);
  }
  out.push('civitai_app_watchdog_wedge_duration_seconds_bucket{le="+Inf"} ' + wedgeCount);
  out.push('civitai_app_watchdog_wedge_duration_seconds_sum ' + wedgeSumSeconds);
  out.push('civitai_app_watchdog_wedge_duration_seconds_count ' + wedgeCount);

  return out.join('\n') + '\n';
}

// FAIL CLOSED. The listener binds 0.0.0.0 (Prometheus scrapes the pod IP), so with no
// token the port is cluster-readable and the whole containment story collapses to
// "it isn't on a Service" — a property of the scrape config, not of this code. A
// watchdog that refuses to expose metrics is a visible failure; one that exposes them
// unauthenticated is an invisible one. Exiting here surfaces as worker_started=0.
if (!token) {
  if (parentPort) {
    parentPort.postMessage({
      type: 'error',
      message: 'refusing to serve metrics: no token configured (WEBHOOK_TOKEN unset)',
    });
  }
  process.exit(1);
}

function tokenAccepted(url) {
  let given = '';
  try {
    given = new URL(url, 'http://localhost').searchParams.get('token') || '';
  } catch (err) {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(function (req, res) {
  const url = req.url || '';
  // Exact path, not endsWith, so a nested path like /anything/metrics cannot serve.
  if (req.method !== 'GET' || url.split('?')[0] !== '/metrics') {
    res.writeHead(404);
    res.end();
    return;
  }
  if (!tokenAccepted(url)) {
    res.writeHead(401);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
  res.end(render());
});

server.on('error', function (err) {
  if (parentPort) parentPort.postMessage({ type: 'error', message: String((err && err.message) || err) });
});

server.listen(port, '0.0.0.0', function () {
  const address = server.address();
  if (parentPort) parentPort.postMessage({ type: 'listening', port: address && address.port });
});

if (parentPort) {
  parentPort.on('message', function (msg) {
    if (msg && msg.type === 'shutdown') {
      // v1 holds no inspector session, but v2 will, and a session still connected
      // at exit prints "Waiting for the debugger to disconnect..." and can hold the
      // process past its termination grace period into a SIGKILL. Wire the teardown
      // path now so that addition has somewhere to go.
      server.close(function () {
        process.exit(0);
      });
      // Don't let a hung connection outlive the grace period.
      setTimeout(function () {
        process.exit(0);
      }, 2000).unref();
    }
  });
}
`;

let worker: Worker | undefined;
let sigtermHooked = false;

/** Test-only accessor for the live worker. */
export function __getWatchdogWorkerForTests(): Worker | undefined {
  return worker;
}

/**
 * Ask the worker to close its listener and exit. Idempotent; safe to call when the
 * watchdog was never armed.
 */
export function shutdownEventLoopWatchdog(): void {
  const current = worker;
  if (!current) return;
  worker = undefined;
  try {
    current.postMessage({ type: 'shutdown' });
  } catch {
    // Worker already gone.
  }
  // The worker exits itself on the shutdown message; terminate() is the backstop for
  // a worker that is wedged in its own right.
  const kill = setTimeout(() => {
    void current.terminate();
  }, 3000);
  kill.unref();
  current.once('exit', () => clearTimeout(kill));
}

/**
 * Spawn the off-loop wedge detector. Safe to call once at server startup, no-op off
 * the nodejs runtime and unless EVENTLOOP_WATCHDOG_ENABLED === 'true'.
 *
 * Arm-time failures must never reject the caller (the OTEL instrumentation
 * register()), so the whole body is wrapped — but unlike the other profilers here, a
 * swallowed failure is NOT invisible: workerStartedGauge is set to 0, and the
 * worker-served `civitai_app_watchdog_up` will be absent.
 */
export function registerEventLoopWatchdog(): void {
  try {
    if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;
    if (!watchdogArmed) return;
    if (worker) return;

    const thresholdMs = resolveWatchdogThresholdMs();
    const heartbeatIntervalMs = resolveWatchdogHeartbeatMs();
    const port = resolveWatchdogPort();

    recordWatchdogHeartbeat();

    worker = new Worker(WATCHDOG_WORKER_SOURCE, {
      eval: true,
      workerData: {
        sab: heartbeatBuffer,
        thresholdMs,
        port,
        // Same ?token= posture as /api/metrics. Absent token => unauthenticated,
        // which is only acceptable because the port is never added to a Service.
        token: process.env.WEBHOOK_TOKEN ?? '',
        heartbeatIntervalMs,
        pollMs: Math.min(DEFAULT_POLL_MS, heartbeatIntervalMs),
      },
      // The watchdog must never be the reason the process stays up.
      stdout: false,
      stderr: false,
    });
    worker.unref();

    worker.on('message', (msg: { type?: string; port?: number; message?: string }) => {
      if (msg?.type === 'listening') {
        console.log(
          `[eventloop-watchdog] armed: worker serving /metrics on :${msg.port} ` +
            `threshold=${thresholdMs}ms heartbeat=${heartbeatIntervalMs}ms`
        );
      } else if (msg?.type === 'error') {
        console.error(`[eventloop-watchdog] worker error: ${msg.message}`);
      }
    });

    worker.on('error', (err) => {
      console.error('[eventloop-watchdog] worker threw; watchdog is no longer running:', err);
      workerStartedGauge().set(0);
      worker = undefined;
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[eventloop-watchdog] worker exited unexpectedly with code ${code}`);
      }
      workerStartedGauge().set(0);
      worker = undefined;
    });

    workerStartedGauge().set(1);

    // Guarded, not `once`: `once` still ADDS a listener per successful spawn, so a
    // respawn after a worker death accumulates them until the MaxListeners warning
    // fires and shutdown runs twice.
    if (!sigtermHooked) {
      sigtermHooked = true;
      process.on('SIGTERM', shutdownEventLoopWatchdog);
    }
  } catch (err) {
    workerStartedGauge().set(0);
    console.error('[eventloop-watchdog] failed to arm; continuing without it:', err);
  }
}
