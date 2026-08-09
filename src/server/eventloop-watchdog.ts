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

import fs from 'node:fs';
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
 * CPU-seconds per wall-second below which a wedge is classified STARVED rather than
 * EXECUTING. Measured separation is total — a burning loop reads 0.89, a blocked one
 * 0.00 — so this sits well clear of both rather than at a midpoint.
 *
 * It is deliberately generous on the starved side: the continuous profiler adds a
 * constant CPU floor on the pools that run it, so a starved wedge need not read
 * exactly zero. The emitted ratio histogram exists so that floor can be READ off real
 * pods rather than guessed at here.
 */
export function resolveStarvedRatio(): number {
  const raw = Number.parseFloat(process.env.EVENTLOOP_WATCHDOG_STARVED_RATIO ?? '');
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.2;
}

/**
 * Paired with the worker-served `civitai_app_watchdog_up`: this one says the main
 * thread spawned the worker, that one says the worker is alive. Neither alone can
 * tell "the watchdog is absent" from "no wedges occurred", which is the failure mode
 * the inline-source note above describes. Together they separate five states:
 *
 *                                 watchdog_up   worker_started   worker_exits_total
 *   healthy                            1              1            0 (both reasons)
 *   MAIN THREAD WEDGED                 1           absent   (only past the scrape timeout — see below)
 *   worker crashed after starting  absent             1          >=1 {reason="crash"}
 *   WEBHOOK_TOKEN missing          absent             1        >=1 {reason="no-token"}
 *   worker never spawned (threw)   absent             0            0 (both reasons)
 *   pod gone                       absent          absent            absent
 *
 * The counter is labelled because the fail-closed exit on a missing token is a
 * CONFIGURATION fault and a crash is a runtime one — different owner, different fix —
 * and without the label they share a signature. An intentional shutdown is not
 * counted at all, or the "worker died" alert would fire on every pod termination.
 *
 * `worker_started` is a SPAWN fact and deliberately not a liveness fact — liveness is
 * what watchdog_up is for. An earlier revision reset it to 0 when the worker died,
 * which collapsed rows 3 and 4 onto the same signature and made "died after starting"
 * indistinguishable from "never spawned". Those have different causes (a runtime
 * crash versus the build-tracing failure this file's inline-source note is about) and
 * different fixes, and distinguishing them was the argument for carrying two metrics
 * at all. The exits counter makes a death positively observable rather than inferred
 * from an absence.
 *
 * Row 2 is SCRAPE-TIMEOUT-BOUND, not instant. A wedged main thread does not refuse
 * the /api/metrics request, it queues it and answers on recovery — measured in
 * preview, the reply landed 30ms after the wedge cleared. So worker_started only goes
 * absent once a wedge outlasts the scrape timeout, for roughly max(0, D-timeout)/interval
 * of scrapes. A short wedge never blanks it. Row 2 is therefore a disambiguator for
 * the long wedges this exists to catch (the real ones ran 4-5 minutes), not the
 * detection signal — that is current_wedge_seconds off the worker's own port, which
 * moves within one poll regardless.
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
        help: 'Whether the main thread successfully spawned the event-loop watchdog worker (1) or tried and failed (0). A SPAWN fact, not a liveness one — it stays 1 if the worker later dies; pair it with civitai_app_watchdog_worker_exits_total for that. Absent means either the watchdog is disarmed on this pod or the main thread cannot serve /api/metrics — compare against the worker-served civitai_app_watchdog_up to tell those apart.',
        registers: [instrumentationRegistry],
      })
  );
}

/**
 * Deaths of a successfully-spawned worker. Registered in the arm path alongside the
 * gauge, for the same reason: a disarmed pod should have no series at all rather than
 * a zero that reads like a healthy armed one.
 */
function workerExitsCounter() {
  return registerInstrumentationMetric(
    PROM_PREFIX + 'watchdog_worker_exits_total',
    () =>
      new client.Counter({
        name: PROM_PREFIX + 'watchdog_worker_exits_total',
        help: 'Unintended exits of the event-loop watchdog worker after a successful spawn, by reason. `no-token` is a configuration fault (WEBHOOK_TOKEN missing, so the worker fails closed rather than serving metrics unauthenticated); `crash` is a runtime death. Non-zero with watchdog_up absent means the worker died, as opposed to never having started (watchdog_worker_started=0). An intentional shutdown does NOT count. The worker is not respawned, so any non-zero value means off-loop observability has ended for this pod.',
        labelNames: ['reason'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

/** Exit code the worker uses when it refuses to serve for lack of a token. */
const EXIT_CODE_NO_TOKEN = 78;

/**
 * Wedge capture, appended to the worker source below.
 *
 * WHY THE INSPECTOR SERVER AND NOT connectToMainThread(): the two paths behave
 * differently against a pinned loop, and the difference decides the design.
 * `connectToMainThread()` is an in-process channel whose `Profiler.enable`/`start`
 * need main-thread dispatch — measured, they return nothing useful when the loop is
 * already blocked (2 samples, top frame anonymous), and against a partially-saturated
 * loop `enable` never settles at all. The inspector SERVER runs on its own thread:
 * arming 8s into a 20s pin gave enable 1ms / start 11ms / stop 2ms and 5,677 samples
 * with 97.3% on the pinning frame, verified in a production pod on Node 24.19.
 *
 * So the trigger fires SIGUSR1 from this thread, which opens the inspector without
 * the main thread's help, and drives CDP over loopback.
 *
 * 🔴 NOTHING HERE MAY REPORT VIA parentPort.postMessage. That queue is drained by the
 * main thread, so during a wedge every message buffers until recovery and is lost if
 * the pod dies first — the reporting path would share the resource being blocked,
 * which is the exact failure this project exists to end. Capture results go into the
 * counters served on the worker's own port, and the profile goes straight out over
 * the worker's own socket.
 *
 * `inspector.close()` is main-thread-only, so the port stays open on loopback until
 * the loop recovers. Bounded to the incident and loopback-only, but real.
 */
const WATCHDOG_CAPTURE_SOURCE = String.raw`
// Defaulted, not required: a malformed or absent capture config must never stop the
// DETECTOR from running. Capture is the optional half, and the detector is not.
const capCfg =
  cap && typeof cap === 'object'
    ? cap
    : { enabled: false, backoffStartMs: 300000, backoffMaxMs: 3600000, maxPerHour: 0, dir: '/tmp', maxFilesOnDisk: 3 };

let captureInFlight = false;
let captureBackoffUntil = 0;
let captureBackoffMs = capCfg.backoffStartMs;
let capturesThisHour = 0;
let capturesHourStart = Date.now();
const captureResults = Object.create(null);
const writeResults = Object.create(null);
let writeBytes = 0;
let lastCaptureAt = 0;

function tallyCapture(result) {
  captureResults[result] = (captureResults[result] || 0) + 1;
}
function tallyWrite(result) {
  writeResults[result] = (writeResults[result] || 0) + 1;
}

// Files this pod has written and not yet seen collected. The harvester deletes only
// AFTER a verified upload, so "still on disk" is the honest backlog signal.
function captureFilesOnDisk() {
  try {
    return fs.readdirSync(capCfg.dir).filter(function (f) {
      return f.indexOf('cpu-wedge-') === 0 && f.slice(-11) === '.cpuprofile';
    }).length;
  } catch (err) {
    return 0;
  }
}

function cdp(ws, method, params) {
  return new Promise(function (resolve, reject) {
    const id = ws.__nextId++;
    ws.__pending.set(id, resolve);
    const timer = setTimeout(function () {
      ws.__pending.delete(id);
      reject(new Error('cdp timeout: ' + method));
    }, capCfg.cdpTimeoutMs);
    ws.__timers.set(id, timer);
    ws.send(JSON.stringify({ id: id, method: method, params: params }));
  });
}

function openInspectorSocket() {
  return new Promise(function (resolve, reject) {
    // SIGUSR1 is handled off the main thread, so this opens the inspector even while
    // the loop is pinned. It is the only reason a trigger-on-detection design works
    // at all.
    try {
      process.kill(process.pid, 'SIGUSR1');
    } catch (err) {
      return reject(new Error('sigusr1 failed: ' + err.message));
    }
    const deadline = Date.now() + capCfg.inspectorWaitMs;
    (function attempt() {
      fetch('http://127.0.0.1:' + capCfg.inspectorPort + '/json/list')
        .then(function (r) { return r.json(); })
        .then(function (list) {
          const target = list && list[0] && list[0].webSocketDebuggerUrl;
          if (!target) throw new Error('no debugger target');
          const ws = new WebSocket(target);
          ws.__nextId = 1;
          ws.__pending = new Map();
          ws.__timers = new Map();
          ws.onmessage = function (ev) {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (err) { return; }
            if (msg.id && ws.__pending.has(msg.id)) {
              clearTimeout(ws.__timers.get(msg.id));
              ws.__timers.delete(msg.id);
              const fn = ws.__pending.get(msg.id);
              ws.__pending.delete(msg.id);
              fn(msg.result);
            }
          };
          ws.onopen = function () { resolve(ws); };
          ws.onerror = function () { reject(new Error('websocket failed')); };
        })
        .catch(function (err) {
          if (Date.now() > deadline) return reject(err);
          setTimeout(attempt, 100);
        });
    })();
  });
}

function captureAllowed(now) {
  if (!capCfg.enabled) return 'disabled';
  if (captureInFlight) return 'in-flight';
  if (now < captureBackoffUntil) return 'backoff';
  if (now - capturesHourStart >= 3600000) {
    capturesHourStart = now;
    capturesThisHour = 0;
  }
  if (capturesThisHour >= capCfg.maxPerHour) return 'hourly-cap';
  return 'ok';
}

async function captureWedge(wedgeStartMs) {
  captureInFlight = true;
  capturesThisHour++;
  let ws;
  try {
    ws = await openInspectorSocket();
    await cdp(ws, 'Profiler.enable');
    await cdp(ws, 'Profiler.setSamplingInterval', { interval: capCfg.samplingIntervalUs });
    await cdp(ws, 'Profiler.start');
    await new Promise(function (r) { setTimeout(r, capCfg.captureMs); });
    const stopped = await cdp(ws, 'Profiler.stop');
    const wedgeMs = Math.round(Date.now() - wedgeStartMs);
    tallyCapture('ok');
    lastCaptureAt = Date.now();

    // 🔴 Write to disk; do NOT ship it from here. The cpu-profile-harvester CronJob in
    // civitai-dp-prod already sweeps <dir>/*.cpuprofile off every pod in the namespace
    // every 15 minutes -- kubectl exec cat, gzip, S3 PUT, HEAD verify, and only then
    // rm. Uploading from the app would mean giving ~163 internet-facing serving pods
    // an object-store credential that the harvester's single short-lived Job already
    // holds; on this cluster that credential is the cluster-wide MinIO identity, which
    // can delete the CNPG Postgres backups. Those pods already carry the database
    // write credential, so adding it would convert a recoverable compromise into an
    // unrecoverable one. The harvester needs no new permission to do this.
    //
    // UNCOMPRESSED and named cpu-*: the harvester matches *.cpuprofile, gzips during
    // transfer itself, and keys the object by image SHA so the profile can be paired
    // with its source maps. A .gz here would simply never be collected.
    const name =
      'cpu-wedge-' + wedgeMs + 'ms-' + capCfg.pod + '-' +
      new Date().toISOString().replace(/[:.]/g, '-') + '.cpuprofile';
    const body = Buffer.from(JSON.stringify(stopped.profile));
    try {
      // Bound the pod's own disk independently of the harvester. maxPerHour limits the
      // rate; this limits the BACKLOG, which is what actually fills /tmp when the
      // harvester is broken or paused. Checked here rather than at trigger time so it
      // reflects what the harvester has genuinely collected.
      if (captureFilesOnDisk() >= capCfg.maxFilesOnDisk) {
        tallyWrite('skipped-disk-cap');
      } else {
        fs.writeFileSync(capCfg.dir + '/' + name, body);
        tallyWrite('ok');
        writeBytes += body.length;
      }
    } catch (err) {
      tallyWrite('error');
    }
  } catch (err) {
    tallyCapture('error');
  } finally {
    if (ws) { try { ws.close(); } catch (err) { /* already gone */ } }
    captureInFlight = false;
    // Exponential, per pod. A sustained wave would otherwise capture the same stack
    // repeatedly and write near-identical multi-MB artifacts.
    captureBackoffUntil = Date.now() + captureBackoffMs;
    captureBackoffMs = Math.min(captureBackoffMs * 2, capCfg.backoffMaxMs);
  }
}

function maybeCaptureWedge(wedgeStartMs) {
  const verdict = captureAllowed(Date.now());
  if (verdict !== 'ok') {
    if (verdict !== 'disabled') tallyCapture('skipped-' + verdict);
    return;
  }
  captureWedge(wedgeStartMs);
}

function renderCaptureMetrics(out) {
  out.push('# HELP civitai_app_watchdog_capture_total Wedge CPU-profile captures attempted, by result. skipped-* results mean the trigger fired but was refused by backoff or the hourly capCfg.');
  out.push('# TYPE civitai_app_watchdog_capture_total counter');
  const captureKeys = ['ok', 'error', 'skipped-in-flight', 'skipped-backoff', 'skipped-hourly-cap', 'skipped-starved'];
  for (const k of captureKeys) {
    out.push('civitai_app_watchdog_capture_total{result="' + k + '"} ' + (captureResults[k] || 0));
  }
  out.push('# HELP civitai_app_watchdog_profile_write_total Profiles written to disk for the cpu-profile-harvester to collect, by result. skipped-disk-cap means the pod is holding its maximum uncollected backlog, which points at the harvester rather than at the app.');
  out.push('# TYPE civitai_app_watchdog_profile_write_total counter');
  const writeKeys = Object.keys(writeResults);
  for (const k of ['ok', 'error', 'skipped-disk-cap']) {
    if (writeKeys.indexOf(k) === -1) writeKeys.push(k);
  }
  for (const k of writeKeys) {
    out.push('civitai_app_watchdog_profile_write_total{result="' + k + '"} ' + (writeResults[k] || 0));
  }
  out.push('# HELP civitai_app_watchdog_profile_write_bytes_total Uncompressed profile bytes written to disk. The harvester gzips in transit, so the stored size is far smaller.');
  out.push('# TYPE civitai_app_watchdog_profile_write_bytes_total counter');
  out.push('civitai_app_watchdog_profile_write_bytes_total ' + writeBytes);
  out.push('# HELP civitai_app_watchdog_profiles_on_disk Captures written and not yet collected. Sustained growth means the harvester is not running; it deletes only after a verified upload.');
  out.push('# TYPE civitai_app_watchdog_profiles_on_disk gauge');
  out.push('civitai_app_watchdog_profiles_on_disk ' + captureFilesOnDisk());
  out.push('# HELP civitai_app_watchdog_last_capture_timestamp_seconds Unix time of the last successful capture, 0 if none.');
  out.push('# TYPE civitai_app_watchdog_last_capture_timestamp_seconds gauge');
  out.push('civitai_app_watchdog_last_capture_timestamp_seconds ' + Math.floor(lastCaptureAt / 1000));
}
`;

/**
 * The worker runs as CommonJS (`eval: true` does not imply ESM) and imports nothing
 * but node: builtins — no prom-client, so there is no bare-specifier resolution to
 * go wrong inside an eval'd worker in the standalone image. The Prometheus text is
 * hand-formatted for the same reason.
 */
export const WATCHDOG_WORKER_SOURCE =
  String.raw`
const { workerData, parentPort } = require('node:worker_threads');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');

const { sab, thresholdMs, port, token, heartbeatIntervalMs, pollMs, cap, starvedRatio } = workerData;
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

// --- starvation classifier -------------------------------------------------
//
// Most wedges on this fleet contain no JS at all: sliced captures showed the thread
// not executing during the wedge, against runqueue wait of 2.28s per second on nodes
// at 90% requested CPU. Threads are queuing, not looping. A profiler cannot see that
// — there is nothing to sample — but CPU time against wall time separates the two
// classes completely. Measured on an idle preview pod: a burning loop reads 0.89, a
// blocked one reads 0.00 — but see below, that separation does not survive contact
// with a pod that has other threads doing work.
//
// 🔴 It must be the MAIN THREAD's CPU, not the process's. process.cpuUsage() sums
// every thread, and a dp-prod pod runs ~58 of them: 32 Prisma tokio workers, 4
// V8Workers doing GC and background JIT, 16 libuv workers, Pyroscope's sampler.
// Measured in production 2026-08-09: the process idles around 0.11-0.14 CPU-s/s and
// wedges came back at a mean ratio of 1.20, so 152 of 154 landed above 1.0 and the
// starved bucket was UNREACHABLE -- every wedge classified executing, including ones
// whose sliced captures showed the main thread not running at all. The two classes do
// NOT sit two orders apart in production; they did in preview, where the pod is idle
// and there is nothing else to count.
//
// The main JS thread's tid equals the process pid on Linux, so /proc/self/task/<pid>/
// stat is that thread and only that thread. utime+stime are fields 14 and 15, in
// USER_HZ ticks -- fixed at 100 by the kernel ABI regardless of CONFIG_HZ, hence 10ms
// per tick.
//
// 🔴 Parse by cutting at the LAST ')': comm is parenthesised and may contain spaces,
// so splitting the line on whitespace shifts every field after it. That exact bug
// silently dropped the main thread from a per-thread CPU table during this
// investigation.
const starvedCutoff = typeof starvedRatio === 'number' && starvedRatio > 0 ? starvedRatio : 0.2;
const CPU_RING_MAX = 400;
const cpuRing = [];
const MAIN_TID = process.pid;
const TICK_MS = 10;

function readMainThreadCpuMs() {
  const raw = fs.readFileSync('/proc/self/task/' + MAIN_TID + '/stat', 'utf8');
  const close = raw.lastIndexOf(')');
  if (close < 0) throw new Error('unparseable stat');
  // After ') ' the first field is state (field 3), so field N is at index N-3.
  const rest = raw.slice(close + 2).split(' ');
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!isFinite(utime) || !isFinite(stime)) throw new Error('unparseable stat');
  return (utime + stime) * TICK_MS;
}

// Chosen ONCE, at startup, and never mixed: alternating sources mid-ring would
// produce deltas between two different populations, which is a wrong ratio rather
// than a missing one. Non-Linux (developer machines) falls back to the process-wide
// reading, which is why cpu_source is exported -- a ratio means something different
// under each source and the reader must be able to tell which one produced it.
let cpuSource = 'process';
try {
  readMainThreadCpuMs();
  cpuSource = 'main-thread';
} catch (err) {
  cpuSource = 'process';
}

function sampleCpu(now) {
  let cpuMs;
  if (cpuSource === 'main-thread') {
    try {
      cpuMs = readMainThreadCpuMs();
    } catch (err) {
      // /proc went away underneath us; degrade rather than stop classifying, and say
      // so in the exported source label.
      cpuSource = 'process';
      const u = process.cpuUsage();
      cpuMs = (u.user + u.system) / 1000;
      cpuRing.length = 0;
    }
  } else {
    const u = process.cpuUsage();
    cpuMs = (u.user + u.system) / 1000;
  }
  cpuRing.push({ at: now, cpuMs: cpuMs });
  if (cpuRing.length > CPU_RING_MAX) cpuRing.shift();
}

// CPU-seconds per wall-second since sinceMs, or null when the ring cannot reach back
// that far. No backticks anywhere in this source -- it lives in a String.raw template
// and one would terminate it.
function cpuRatioSince(sinceMs, now) {
  if (cpuRing.length < 2) return null;
  let oldest = null;
  for (let i = 0; i < cpuRing.length; i++) {
    if (cpuRing[i].at <= sinceMs) oldest = cpuRing[i];
    else break;
  }
  if (!oldest) oldest = cpuRing[0];
  const latest = cpuRing[cpuRing.length - 1];
  const wallMs = latest.at - oldest.at;
  if (wallMs < 200) return null;
  return (latest.cpuMs - oldest.cpuMs) / wallMs;
}

const wedgeKinds = { starved: 0, executing: 0, unknown: 0 };
const RATIO_BUCKETS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
const ratioBucketCounts = new Array(RATIO_BUCKETS.length).fill(0);
let ratioCount = 0;
let ratioSum = 0;

function observeWedgeKind(ratio) {
  if (ratio === null) {
    wedgeKinds.unknown++;
    return;
  }
  wedgeKinds[ratio < starvedCutoff ? 'starved' : 'executing']++;
  ratioCount++;
  ratioSum += ratio;
  for (let i = 0; i < RATIO_BUCKETS.length; i++) {
    if (ratio <= RATIO_BUCKETS[i]) ratioBucketCounts[i]++;
  }
}

setInterval(function () {
  const now = Date.now();
  sampleCpu(now);
  const lastBeat = lastBeatMs();
  const age = now - lastBeat;
  if (wedgeStartedAt === 0) {
    // Date the wedge from the last beat, not from detection, so the reported
    // duration does not silently exclude the threshold.
    if (age >= thresholdMs) {
      wedgeStartedAt = lastBeat;
      // Gate on the ratio SO FAR, which is all that exists at detection. The
      // classification below uses the whole wedge and is the more accurate of the
      // two; this one only has to answer "is there anything to sample right now".
      const earlyRatio = cpuRatioSince(wedgeStartedAt, now);
      if (earlyRatio !== null && earlyRatio < starvedCutoff) {
        tallyCapture('skipped-starved');
      } else {
        // Fire-and-forget: the capture must not delay the next poll, or the worker
        // stops being able to report the wedge it is capturing.
        maybeCaptureWedge(wedgeStartedAt);
      }
    }
  } else if (age < thresholdMs) {
    observeWedge((now - wedgeStartedAt) / 1000);
    observeWedgeKind(cpuRatioSince(wedgeStartedAt, now));
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

  out.push('# HELP civitai_app_watchdog_wedge_kind_total Completed wedges by whether the main thread was EXECUTING (CPU burned during the wedge, so a profile has something to show) or STARVED (descheduled, waiting for CPU — nothing to sample, and the fix is capacity or scheduling rather than code). unknown means the CPU ring could not cover the wedge.');
  out.push('# TYPE civitai_app_watchdog_wedge_kind_total counter');
  out.push('civitai_app_watchdog_wedge_kind_total{kind="starved"} ' + wedgeKinds.starved);
  out.push('civitai_app_watchdog_wedge_kind_total{kind="executing"} ' + wedgeKinds.executing);
  out.push('civitai_app_watchdog_wedge_kind_total{kind="unknown"} ' + wedgeKinds.unknown);

  out.push('# HELP civitai_app_watchdog_wedge_cpu_ratio MAIN-THREAD CPU-seconds per wall-second over each completed wedge, per civitai_app_watchdog_cpu_source. Distribution, not last-value, so the starved population can be READ rather than assumed. Under source="process" this counts all ~58 threads and cannot reach the starved buckets on a serving pod — read the source label before reading the distribution.');
  out.push('# TYPE civitai_app_watchdog_wedge_cpu_ratio histogram');
  for (let i = 0; i < RATIO_BUCKETS.length; i++) {
    out.push('civitai_app_watchdog_wedge_cpu_ratio_bucket{le="' + RATIO_BUCKETS[i] + '"} ' + ratioBucketCounts[i]);
  }
  out.push('civitai_app_watchdog_wedge_cpu_ratio_bucket{le="+Inf"} ' + ratioCount);
  out.push('civitai_app_watchdog_wedge_cpu_ratio_sum ' + ratioSum);
  out.push('civitai_app_watchdog_wedge_cpu_ratio_count ' + ratioCount);

  gauge('civitai_app_watchdog_starved_ratio_threshold', 'Configured CPU-ratio below which a wedge is classified starved. Config echo.', starvedCutoff);
  // Not cosmetic. The same ratio means different things under the two sources, and a
  // fleet silently on the process-wide fallback would report every wedge as executing
  // while looking perfectly healthy — the exact failure this patch exists to end.
  out.push('# HELP civitai_app_watchdog_cpu_source Which CPU clock feeds the wedge classifier: main-thread (/proc/self/task/<pid>/stat, correct) or process (process.cpuUsage() fallback, counts every thread and cannot classify starved on a busy pod).');
  out.push('# TYPE civitai_app_watchdog_cpu_source gauge');
  out.push('civitai_app_watchdog_cpu_source{source="main-thread"} ' + (cpuSource === 'main-thread' ? 1 : 0));
  out.push('civitai_app_watchdog_cpu_source{source="process"} ' + (cpuSource === 'process' ? 1 : 0));

  renderCaptureMetrics(out);

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
  // 78 is sysexits' EX_CONFIG. A distinct code — not the postMessage above — is what
  // the parent keys the exit reason on: the message and the exit event race, the code
  // arrives with the exit itself.
  process.exit(78);
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
` + WATCHDOG_CAPTURE_SOURCE;

/**
 * Capture is a SEPARATE gate from the watchdog itself. Detection is cheap and safe to
 * run everywhere; capture opens an inspector, drives CDP and uploads, so it stays off
 * until deliberately turned on per pool.
 */
export function resolveCaptureConfig() {
  const enabled = process.env.EVENTLOOP_WATCHDOG_CAPTURE_ENABLED === 'true';
  return {
    enabled,
    captureMs: clamp(
      parsePositiveInt(process.env.EVENTLOOP_WATCHDOG_CAPTURE_MS) ?? 10_000,
      1000,
      30_000
    ),
    // 100Hz, matching the continuous profiler's rate. The old in-process path sampled
    // at 1kHz and produced 41-46MB profiles on SSR.
    samplingIntervalUs: clamp(
      parsePositiveInt(process.env.EVENTLOOP_WATCHDOG_CAPTURE_INTERVAL_US) ?? 10_000,
      1000,
      100_000
    ),
    maxPerHour: clamp(
      parsePositiveInt(process.env.EVENTLOOP_WATCHDOG_CAPTURE_MAX_PER_HOUR) ?? 3,
      1,
      60
    ),
    backoffStartMs: 5 * 60_000,
    backoffMaxMs: 60 * 60_000,
    inspectorPort: parsePositiveInt(process.env.EVENTLOOP_WATCHDOG_INSPECTOR_PORT) ?? 9229,
    inspectorWaitMs: 5000,
    cdpTimeoutMs: 15_000,
    // Must match the harvester's PROFILE_DIR (default /tmp in the
    // cpu-profile-harvester CronJob). A mismatch is silent on both sides: the app
    // writes happily and the sweep finds nothing.
    dir: process.env.CPU_PROFILE_DIR ?? '/tmp',
    // Backlog ceiling, not a rate limit — maxPerHour is the rate limit. The harvester
    // collects up to MAX_FILES_PER_POD=3 per 15-minute run, so 3 is one full run of
    // slack before the pod starts refusing to write.
    maxFilesOnDisk: clamp(
      parsePositiveInt(process.env.EVENTLOOP_WATCHDOG_MAX_PROFILES_ON_DISK) ?? 3,
      1,
      20
    ),
    pool: process.env.SERVICE_NAME ?? 'unknown',
    pod: resolvePodName(),
    imageTag: process.env.APP_VERSION ?? process.env.IMAGE_TAG ?? 'unknown',
  };
}

function resolvePodName(): string {
  return process.env.PODNAME ?? process.env.HOSTNAME ?? 'unknown';
}

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
    const captureConfig = resolveCaptureConfig();

    // Fail LOUDLY at boot rather than during the first wedge, when nobody is reading
    // logs for a capture that silently went nowhere. The directory is the whole
    // contract with the harvester and a mismatch is invisible from both sides.
    if (captureConfig.enabled) {
      try {
        fs.accessSync(captureConfig.dir, fs.constants.W_OK);
      } catch {
        console.error(
          `[eventloop-watchdog] capture is ENABLED but ${captureConfig.dir} is not writable; wedges will be captured and then dropped`
        );
      }
    }

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
        // Resolved on the MAIN thread at spawn, so a bad config is a boot-time fact
        // rather than something discovered during the first wedge.
        cap: captureConfig,
        starvedRatio: resolveStarvedRatio(),
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

    // Neither handler touches workerStartedGauge: the spawn DID happen, and zeroing it
    // here is what made a runtime death indistinguishable from never having started.
    worker.on('error', (err) => {
      console.error('[eventloop-watchdog] worker threw; watchdog is no longer running:', err);
      workerExitsCounter().inc({ reason: 'crash' });
      worker = undefined;
    });

    worker.on('exit', (code) => {
      worker = undefined;
      // Code 0 is our own shutdown path; counting it would make the "worker died"
      // alert fire during every ordinary pod termination.
      if (code === 0) return;

      const reason = code === EXIT_CODE_NO_TOKEN ? 'no-token' : 'crash';
      console.error(
        `[eventloop-watchdog] worker exited with code ${code} (${reason}); watchdog is no longer running`
      );
      workerExitsCounter().inc({ reason });
    });

    workerStartedGauge().set(1);
    // Seed both label values at 0 rather than waiting for a death, so an
    // armed-and-healthy pod reports `exits_total 0` instead of no series at all.
    // Absent and zero mean different things and an alert cannot tell them apart.
    workerExitsCounter().inc({ reason: 'crash' }, 0);
    workerExitsCounter().inc({ reason: 'no-token' }, 0);

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
