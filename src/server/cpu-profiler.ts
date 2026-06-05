// On-demand V8 CPU profiler, triggered by a process signal.
//
// WHY: civitai-dp-prod API pods periodically CPU-saturate the single Node
// thread (p95 pod CPU = 1.0 core) during traffic waves, starving the event
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
// Server-side (nodejs runtime) only. Never imported on the edge/client.

import inspector from 'node:inspector';
import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

const DEFAULT_SIGNAL = 'SIGWINCH';
const DEFAULT_DURATION_SECONDS = 25;
const MAX_DURATION_SECONDS = 120;
const DEFAULT_OUTPUT_DIR = '/tmp';

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

/**
 * Run a single CPU profile capture using an in-process inspector Session.
 * Resolves once the .cpuprofile has been written (or rejects on failure).
 * Does NOT need the inspector port (:9229) to be open.
 */
async function captureProfile(): Promise<string> {
  const durationMs = resolveDurationMs();
  const outputDir = resolveOutputDir();
  const pod = resolvePodName();
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(outputDir, `cpu-${pod}-${iso}.cpuprofile`);

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
