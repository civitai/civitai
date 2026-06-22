// On-demand V8 CPU profiler — triggered by a process signal OR self-armed by
// the app's own rising event-loop lag.
//
// WHY: civitai-dp-prod API pods periodically CPU-saturate the single Node
// thread (p95 pod CPU = 1.0 core) during traffic "504 waves", starving the event
// loop until liveness probes fail and the pod is SIGKILLed. The CPU consumer
// is not visible in any instrumented span. A real V8 CPU profile from a
// saturated pod is the only way to see which JS functions burn the CPU.
//
// This registers a signal handler that, on demand, captures a `.cpuprofile`
// (Chrome DevTools / speedscope format) via the in-process `node:inspector`
// Session API and writes it to a retrievable, writable directory. It does
// ZERO work until signalled — no steady-state overhead.
//
// SIGNAL CHOICE: SIGUSR2 is already claimed by Node's `--heapsnapshot-signal`
// flag, and SIGUSR1 is Node's built-in "open the inspector port" signal that
// the cluster heap-snapshot tooling relies on (`kill -USR1 1` opens :9229,
// which `HeapProfiler.takeHeapSnapshot` is then driven over). Registering a
// userland SIGUSR1 listener would OVERRIDE that default and break heap
// snapshots. So the default trigger is SIGWINCH — a no-op for a non-TTY
// server process that Kubernetes never sends — and the signal is overridable
// via CPU_PROFILE_SIGNAL for operators who know what they are doing.
//
// THE SIGWINCH BLACK-HOLE (why we ALSO need a self-trigger): an EXTERNAL signal
// cannot be delivered to JS while the loop is fully pinned. SIGWINCH-on-pin
// reliably FAILS: the pegged loop never runs the handler (so 0 profiles), or by
// the time the handler runs the pod has already recovered (so only idle
// profiles). Proven empirically 2026-06-22. The fix below is an INTERNALLY-ARMED
// self-trigger: a lag watchdog starts the profiler the moment the app detects
// its OWN event-loop lag rising. Once `Profiler.start` is issued, V8's sampling
// runs on a SEPARATE thread and keeps sampling the pinned main thread even while
// JS blocks; the profile is written on recovery. That separate-thread sampling is
// the one mechanism that beats the black-hole. See registerEventLoopStallProfiler.
//
// Server-side (nodejs runtime) only. Never imported on the edge/client. It
// pulls in node:inspector and node:perf_hooks — both server-only natives that
// MUST NEVER reach the client bundle. The single import site is
// src/instrumentation.node.ts (nodejs runtime). Do not import this file from any
// client-reachable module.

import inspector from 'node:inspector';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFile, readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

const DEFAULT_SIGNAL = 'SIGWINCH';
const DEFAULT_DURATION_SECONDS = 25;
const MAX_DURATION_SECONDS = 120;
const DEFAULT_OUTPUT_DIR = '/tmp';
// Max `.cpuprofile` files allowed in the output dir before a capture is refused
// (bounds disk on the unrotated, heartbeat-shared writable layer). Override with
// CPU_PROFILE_MAX_FILES.
const DEFAULT_MAX_PROFILE_FILES = 12;

// --- Event-loop stall self-trigger (default OFF) --------------------------
// The watchdog is DISARMED unless CPU_PROFILE_LAG_TRIGGER_MS is set to a
// positive number. When unset/0/invalid the watchdog is never installed → zero
// steady-state overhead (no extra timer, no histogram). When armed it adds one
// unref'd setInterval + a libuv-internal lag histogram (C++-measured, no
// per-event JS cost).
//
// Suggested production value: 1000 (a 1s+ event-loop stall). Normal lag is
// <50ms; a 1s stall already means the pod is well into a pin. Lower the trigger
// to catch the rising edge of a wave earlier (see the mechanism note on
// registerEventLoopStallProfiler).
const DEFAULT_LAG_CHECK_MS = 500;
const MIN_LAG_CHECK_MS = 50;
// Floor on the trigger threshold so a fat-fingered tiny value (e.g. 5) doesn't
// arm a profile on every ordinary GC pause / normal lag spike.
const MIN_LAG_TRIGGER_MS = 100;
const DEFAULT_LAG_COOLDOWN_MS = 60_000;
// monitorEventLoopDelay sampling resolution (ms). 20ms is fine-grained enough to
// see a building stall without measurable cost.
const LAG_HISTOGRAM_RESOLUTION_MS = 20;

// Known Node.js signal names that can be the target of a userland process.on
// listener. A bogus CPU_PROFILE_SIGNAL must not throw ERR_UNKNOWN_SIGNAL at
// arm-time (that would take down the whole instrumentation register()).
const KNOWN_SIGNALS = new Set<string>([
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGILL',
  'SIGTRAP',
  'SIGABRT',
  'SIGBUS',
  'SIGFPE',
  'SIGUSR1',
  'SIGUSR2',
  'SIGSEGV',
  'SIGPIPE',
  'SIGALRM',
  'SIGTERM',
  'SIGCHLD',
  'SIGCONT',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGURG',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGVTALRM',
  'SIGPROF',
  'SIGWINCH',
  'SIGIO',
  'SIGPWR',
  'SIGSYS',
]);

let capturing = false;

function resolveSignal(): NodeJS.Signals {
  const raw = (process.env.CPU_PROFILE_SIGNAL || DEFAULT_SIGNAL).trim();
  return raw as NodeJS.Signals;
}

function resolvePodName(): string {
  // PODNAME is injected explicitly by the deployment (metadata.name);
  // HOSTNAME is the implicit fallback, then the OS hostname.
  return process.env.PODNAME || process.env.HOSTNAME || hostname();
}

function resolveDurationMs(): number {
  const raw = process.env.CPU_PROFILE_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  let seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DURATION_SECONDS;
  // Clamp (don't throw) so a fat-fingered env can't request a multi-minute profile.
  if (seconds > MAX_DURATION_SECONDS) {
    seconds = MAX_DURATION_SECONDS;
  }
  return seconds * 1000;
}

function resolveOutputDir(): string {
  return (process.env.CPU_PROFILE_DIR || DEFAULT_OUTPUT_DIR).trim();
}

// Disk-bound guard. The output dir (default /tmp) has no rotation and — on
// dp-prod — is the SAME writable layer as the liveness `/tmp/heartbeat`. The
// lag self-trigger fires UNATTENDED and repeatedly during a sustained/recurring
// wave (~1 profile / (duration+cooldown)), each multi-MB, so without a cap a
// long wave could fill the layer → heartbeat write fails → liveness reaps the
// pod (the profiler becoming a CAUSE of an incident). Before each capture we
// refuse if the dir already holds >= this many `*.cpuprofile` files; the
// operator retrieves + deletes them out of band. Applies to BOTH the SIGWINCH
// and lag-trigger paths.
export function resolveMaxProfileFiles(): number {
  const raw = process.env.CPU_PROFILE_MAX_FILES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PROFILE_FILES;
}

// Count existing .cpuprofile files in the output dir. Best-effort: a readdir
// failure (missing dir, perms) must never block a capture — return 0 so we
// proceed (the write itself will surface a real error).
async function countExistingProfiles(outputDir: string): Promise<number> {
  try {
    const entries = await readdir(outputDir);
    return entries.filter((f) => f.endsWith('.cpuprofile')).length;
  } catch {
    return 0;
  }
}

/**
 * Resolve the event-loop-stall trigger threshold in ms. The watchdog is the
 * thing that beats the SIGWINCH black-hole, but it stays DISARMED unless this is
 * an explicit positive number — so it is zero-overhead by default. Unset / 0 /
 * non-numeric → 0 (do not arm). A positive value below MIN_LAG_TRIGGER_MS is
 * clamped UP to the floor (don't throw) so a fat-fingered tiny value can't
 * profile on every ordinary lag spike.
 */
function resolveLagTriggerMs(): number {
  const raw = process.env.CPU_PROFILE_LAG_TRIGGER_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(parsed, MIN_LAG_TRIGGER_MS);
}

/** How often the watchdog reads + resets the lag histogram. Clamped to a floor. */
function resolveLagCheckMs(): number {
  const parsed = Number.parseInt(process.env.CPU_PROFILE_LAG_CHECK_MS ?? '', 10);
  const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LAG_CHECK_MS;
  return Math.max(ms, MIN_LAG_CHECK_MS);
}

/** Suppress re-triggering for this long after a capture completes. */
function resolveLagCooldownMs(): number {
  const parsed = Number.parseInt(process.env.CPU_PROFILE_LAG_COOLDOWN_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LAG_COOLDOWN_MS;
}

function delay(ms: number): { promise: Promise<void>; timer: NodeJS.Timeout } {
  let timer!: NodeJS.Timeout;
  const promise = new Promise<void>((resolve) => {
    // NOT unref'd: a bounded capture timer must actually fire even on an idle
    // pod (rehearsal/validation), otherwise the loop drains, the timer never
    // fires, and Profiler.stop + write silently never happen. A 25s ref'd timer
    // cannot meaningfully delay shutdown (terminationGracePeriodSeconds: 60 +
    // 20s preStop).
    timer = setTimeout(resolve, ms);
  });
  return { promise, timer };
}

// ---------------------------------------------------------------------------
// Lag-trigger decision (pure, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Pure decision: given a max-lag reading + the resolved config + the current
 * capture/cooldown state, should the watchdog fire an auto-capture right now?
 *
 * Factored out of the timer so the trigger logic is testable WITHOUT a real
 * inspector, real timers, or perf_hooks. The watchdog timer simply reads the
 * libuv histogram's `max`, converts ns→ms, and feeds it here.
 *
 * Order of the gates matters for clarity but not correctness (all must pass):
 *   - triggerMs <= 0          → watchdog disabled (defensive; we don't install
 *                               the timer at all when disabled, but keep the
 *                               guard so the function is self-contained).
 *   - capturing               → a capture (signal OR a prior auto-fire) is in
 *                               flight; never overlap (mirrors the SIGWINCH guard).
 *   - now < cooldownUntil     → inside the post-capture cooldown; a sustained
 *                               wave must not back-to-back profile.
 *   - maxLagMs < triggerMs    → lag below threshold; nothing to capture.
 */
export function shouldTriggerLagCapture(args: {
  maxLagMs: number;
  triggerMs: number;
  capturing: boolean;
  nowMs: number;
  cooldownUntilMs: number;
}): boolean {
  const { maxLagMs, triggerMs, capturing, nowMs, cooldownUntilMs } = args;
  if (triggerMs <= 0) return false;
  if (capturing) return false;
  if (nowMs < cooldownUntilMs) return false;
  return maxLagMs >= triggerMs;
}

/**
 * Run a single CPU profile capture using an in-process inspector Session.
 * Resolves once the .cpuprofile has been written (or rejects on failure).
 * Does NOT need the inspector port (:9229) to be open.
 *
 * @param labelSegment optional filename segment that distinguishes the trigger
 *   source. The signal path passes nothing → `cpu-<pod>-<iso>.cpuprofile`. The
 *   lag watchdog passes `loopstall-<lagMs>ms` → `cpu-loopstall-<lagMs>ms-<pod>-
 *   <iso>.cpuprofile`, so operators can tell auto-captures apart and read the
 *   trigger lag straight off the filename.
 */
async function captureProfile(labelSegment?: string): Promise<string> {
  const durationMs = resolveDurationMs();
  const outputDir = resolveOutputDir();

  // Disk-bound guard (protects the heartbeat-shared writable layer — see
  // resolveMaxProfileFiles). Refuse rather than fill the disk; the operator
  // clears retrieved profiles to re-enable capture.
  const maxFiles = resolveMaxProfileFiles();
  const existing = await countExistingProfiles(outputDir);
  if (existing >= maxFiles) {
    throw new Error(
      `[cpu-profiler] refusing capture: ${existing} .cpuprofile file(s) already in ${outputDir} ` +
        `(>= CPU_PROFILE_MAX_FILES=${maxFiles}). Retrieve + delete them to re-enable capture.`
    );
  }

  const pod = resolvePodName();
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = labelSegment ? `cpu-${labelSegment}-` : 'cpu-';
  const filePath = path.join(outputDir, `${prefix}${pod}-${iso}.cpuprofile`);

  const session = new inspector.Session();
  // Track whether we actually wrote a profile so an interrupted capture
  // (shutdown / timer cleared) is never silent.
  let wrote = false;
  let captureTimer: NodeJS.Timeout | undefined;

  // Promisified inspector.Session#post — the callback form is the only API.
  const post = <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      // The typings only expose specific method overloads; cast through unknown
      // to keep this generic without fighting the union of literal signatures.
      (
        session.post as unknown as (
          m: string,
          p: Record<string, unknown> | undefined,
          cb: (err: Error | null, res: T) => void
        ) => void
      )(method, params, (err, res) => (err ? reject(err) : resolve(res)));
    });

  try {
    session.connect();

    await post('Profiler.enable');
    await post('Profiler.start');

    console.log(`[cpu-profiler] capture started: duration=${durationMs / 1000}s -> ${filePath}`);

    const { promise, timer } = delay(durationMs);
    captureTimer = timer;
    await promise;

    const { profile } = await post<{ profile: unknown }>('Profiler.stop');

    await writeFile(filePath, JSON.stringify(profile), 'utf8');
    wrote = true;

    // kubectl cp strips/rejects a leading slash on the source path, so pass the
    // path without it. The namespace differs across deployments
    // (civitai-dp-prod / civitai-next / civitai-app / PR previews), so leave it
    // as a placeholder for the operator to fill in.
    const cpSource = filePath.replace(/^\/+/, '');
    console.log(
      `[cpu-profiler] capture complete: wrote ${filePath}. ` +
        `Retrieve with: kubectl cp <namespace>/${pod}:${cpSource} ./${path.basename(filePath)} ` +
        `then open in Chrome DevTools (Performance > Load profile) or https://speedscope.app`
    );

    return filePath;
  } finally {
    if (captureTimer) {
      clearTimeout(captureTimer);
    }
    if (!wrote) {
      console.warn(
        `[cpu-profiler] CPU profile capture did not complete (inspector or write error); ` +
          `no profile written to ${filePath}.`
      );
    }
    try {
      await post('Profiler.disable');
    } catch {
      // best-effort cleanup
    }
    try {
      session.disconnect();
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Register the on-demand CPU profiler signal handler.
 * Safe to call once at server startup. No-op off the nodejs runtime.
 */
export function registerCpuProfiler(): void {
  // Arm-time failures must never reject the caller (the OTEL instrumentation
  // register()). Wrap the whole body so any unexpected error logs and no-ops.
  try {
    if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') {
      return;
    }

    const signal = resolveSignal();

    // An unknown signal name would make process.on(signal, …) throw
    // ERR_UNKNOWN_SIGNAL. Validate first and no-op (don't arm) rather than
    // throw, so a bogus CPU_PROFILE_SIGNAL can't take down OTEL on boot.
    if (!KNOWN_SIGNALS.has(signal)) {
      console.warn(
        `[cpu-profiler] not armed: CPU_PROFILE_SIGNAL="${signal}" is not a known Node signal; ignoring.`
      );
      return;
    }

    process.on(signal, () => {
      if (capturing) {
        console.log(
          `[cpu-profiler] ${signal} received but a capture is already in progress; ignoring.`
        );
        return;
      }

      capturing = true;
      captureProfile()
        .catch((err) => {
          // A profiling failure must never crash the process.
          console.error('[cpu-profiler] capture failed:', err);
        })
        .finally(() => {
          capturing = false;
        });
    });

    console.log(
      `[cpu-profiler] armed: send ${signal} to PID 1 to capture a ` +
        `${resolveDurationMs() / 1000}s CPU profile to ${resolveOutputDir()} ` +
        `(override with CPU_PROFILE_SIGNAL / CPU_PROFILE_SECONDS / CPU_PROFILE_DIR)`
    );
  } catch (err) {
    console.error('[cpu-profiler] failed to arm; continuing without CPU profiler:', err);
  }
}

// ---------------------------------------------------------------------------
// Event-loop stall self-trigger watchdog
// ---------------------------------------------------------------------------

// End-of-cooldown timestamp (epoch ms). Until `Date.now()` passes this, a
// completed auto-capture suppresses re-triggering so a sustained wave doesn't
// back-to-back profile. Shared with the watchdog timer below.
let lagCooldownUntil = 0;

/**
 * Register the event-loop-stall self-trigger watchdog.
 *
 * THE MECHANISM (and why it beats the SIGWINCH black-hole — see the file header):
 * an external signal can't be delivered to a pinned loop, but the app can watch
 * its OWN lag and arm V8's profiler before/while it pins. We enable a
 * `monitorEventLoopDelay` histogram (libuv-internal, C++-measured — no per-event
 * JS cost) and read its `max` every CPU_PROFILE_LAG_CHECK_MS. When max lag crosses
 * the threshold we call the SAME captureProfile() the signal path uses, under the
 * SAME `capturing` guard, so the two trigger sources never overlap.
 *
 * SUSTAINED-WAVE NUANCE: if the loop is ALREADY fully pinned, the check timer
 * itself can't fire mid-block — but `monitorEventLoopDelay` ACCUMULATES the max
 * across blocks, so the check fires right AFTER a block ends and reads the high
 * max → starts the profiler → which then samples SUBSEQUENT bursts of the same
 * wave on its separate thread. The 504 waves last minutes / recur in bursts, so a
 * capture armed one block late still lands squarely on the pin we care about.
 * Lowering CPU_PROFILE_LAG_TRIGGER_MS catches the rising edge earlier (more lead
 * time before a full peg) at the cost of more false-positive captures.
 *
 * DEFAULT OFF: no-op (nothing installed, zero overhead) unless
 * CPU_PROFILE_LAG_TRIGGER_MS is a positive number. Like registerCpuProfiler, an
 * arm-time failure must never reject the caller (OTEL register()), so the whole
 * body is wrapped.
 */
export function registerEventLoopStallProfiler(): void {
  try {
    if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') {
      return;
    }

    const triggerMs = resolveLagTriggerMs();
    if (triggerMs <= 0) {
      // DISARMED (the default). Nothing installed — no timer, no histogram.
      return;
    }

    const checkMs = resolveLagCheckMs();
    const cooldownMs = resolveLagCooldownMs();

    // libuv-internal lag histogram. .enable() starts accumulating; we read .max
    // (ns) and .reset() each tick so each window is independent.
    const h = monitorEventLoopDelay({ resolution: LAG_HISTOGRAM_RESOLUTION_MS });
    h.enable();

    const timer = setInterval(() => {
      let maxLagMs = 0;
      try {
        const maxNs = h.max;
        maxLagMs = Number.isFinite(maxNs) ? maxNs / 1e6 : 0;
        h.reset();
      } catch {
        // Reading/resetting the histogram must never crash the watchdog.
        return;
      }

      if (
        !shouldTriggerLagCapture({
          maxLagMs,
          triggerMs,
          capturing,
          nowMs: Date.now(),
          cooldownUntilMs: lagCooldownUntil,
        })
      ) {
        return;
      }

      const lagRounded = Math.round(maxLagMs);
      console.log(
        `[cpu-profiler] event-loop stall ${lagRounded}ms >= threshold ${triggerMs}ms — ` +
          `starting auto-capture`
      );

      capturing = true;
      captureProfile(`loopstall-${lagRounded}ms`)
        .catch((err) => {
          // A profiling failure must never crash the process.
          console.error('[cpu-profiler] auto-capture failed:', err);
        })
        .finally(() => {
          capturing = false;
          // Start the cooldown AFTER the capture completes, so a sustained wave
          // doesn't immediately re-fire the moment the profile is written.
          lagCooldownUntil = Date.now() + cooldownMs;
        });
    }, checkMs);

    // Don't keep the process alive solely for this watchdog timer (shutdown).
    timer.unref();

    console.log(
      `[cpu-profiler] event-loop stall self-trigger armed: trigger=${triggerMs}ms ` +
        `check=${checkMs}ms cooldown=${cooldownMs}ms (auto-captures a ` +
        `${resolveDurationMs() / 1000}s profile to ${resolveOutputDir()} when loop lag ` +
        `crosses the threshold; override with CPU_PROFILE_LAG_TRIGGER_MS / ` +
        `CPU_PROFILE_LAG_CHECK_MS / CPU_PROFILE_LAG_COOLDOWN_MS)`
    );
  } catch (err) {
    console.error(
      '[cpu-profiler] failed to arm event-loop stall self-trigger; continuing without it:',
      err
    );
  }
}

// ---------------------------------------------------------------------------
// Test-only hooks (not for production use)
// ---------------------------------------------------------------------------

/** Test-only: reset the shared cooldown timestamp between cases. */
export function __resetLagCooldownForTests(): void {
  lagCooldownUntil = 0;
}
