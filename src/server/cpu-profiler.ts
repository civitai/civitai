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
const DEFAULT_OUTPUT_DIR = '/tmp';

let capturing = false;

function resolveSignal(): NodeJS.Signals {
  const raw = (process.env.CPU_PROFILE_SIGNAL || DEFAULT_SIGNAL).trim();
  return raw as NodeJS.Signals;
}

function resolveDurationMs(): number {
  const raw = process.env.CPU_PROFILE_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DURATION_SECONDS;
  return seconds * 1000;
}

function resolveOutputDir(): string {
  return (process.env.CPU_PROFILE_DIR || DEFAULT_OUTPUT_DIR).trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // unref so a pending capture never holds the process open on shutdown.
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Run a single CPU profile capture using an in-process inspector Session.
 * Resolves once the .cpuprofile has been written (or rejects on failure).
 * Does NOT need the inspector port (:9229) to be open.
 */
async function captureProfile(): Promise<string> {
  const durationMs = resolveDurationMs();
  const outputDir = resolveOutputDir();
  const pod = process.env.HOSTNAME || hostname();
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(outputDir, `cpu-${pod}-${iso}.cpuprofile`);

  const session = new inspector.Session();

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

    await delay(durationMs);

    const { profile } = await post<{ profile: unknown }>('Profiler.stop');

    await writeFile(filePath, JSON.stringify(profile), 'utf8');

    console.log(
      `[cpu-profiler] capture complete: wrote ${filePath}. ` +
        `Retrieve with: kubectl cp civitai-dp-prod/${pod}:${filePath} ./${path.basename(
          filePath
        )} ` +
        `then open in Chrome DevTools (Performance > Load profile) or https://speedscope.app`
    );

    return filePath;
  } finally {
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
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const signal = resolveSignal();

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
}
