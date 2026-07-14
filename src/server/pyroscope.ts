// Stage 1 of the Pyroscope continuous-profiling integration. Ships DARK: a
// complete no-op unless PYROSCOPE_ENABLED='true' is set on the deployment.
//
// WHY: civitai-dp-prod pools (api-primary / SSR) are ceiling-capped at the true
// daily peak, so per-request server-CPU cuts are the live lever (they lower
// peak-need, relieving the pod-cap ceiling without spending on more replicas).
// Continuous CPU/wall profiling ranks the on-CPU functions at real peak so we
// can book those cuts the same way /app-perf-next-lever books server-CPU wins.
//
// Grafana's @pyroscope/nodejs SDK runs an in-process V8 wall/cpu sampler
// (@datadog/pprof) and pushes pprof over HTTP to an ingest endpoint. This
// mirrors src/server/cpu-profiler.ts's discipline: server/nodejs-only, a single
// import site (src/instrumentation.node.ts), zero steady-state overhead when
// off, and arm-time failures that can NEVER crash boot.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHY THIS USES A FLAG-GATED **DYNAMIC** import (not a static one):
// @pyroscope/nodejs → @datadog/pprof loads its native .node addon EAGERLY at
// require()-time (node-gyp-build runs at module top-level). So a STATIC
// `import Pyroscope from '@pyroscope/nodejs'` would load the native addon at BOOT
// on every pod even when dark — which is NOT a no-op. Loading the package only
// inside registerPyroscope() (behind the flag) keeps the dark build a TRUE
// no-op: the package + its native addon are never touched unless armed. Same
// lazy-import discipline instrumentation.node.ts already uses for the warmer.
// ─────────────────────────────────────────────────────────────────────────────
//
// Server-side (nodejs runtime) only. Never import the @pyroscope/nodejs package
// statically from any client-reachable module — it pulls in @datadog/pprof's
// native profiler.

// Read the gate ONCE at module load.
export const pyroscopeArmed = process.env.PYROSCOPE_ENABLED === 'true';

function resolvePod(): string {
  // Mirror cpu-profiler's precedence: explicit PODNAME (metadata.name), then the
  // implicit HOSTNAME.
  return process.env.PODNAME ?? process.env.HOSTNAME ?? 'unknown';
}

/**
 * Arm the Pyroscope continuous profiler. Safe to call once at server startup.
 * No-op unless PYROSCOPE_ENABLED='true' AND PYROSCOPE_SERVER_ADDRESS is set.
 * Async because it dynamically imports the SDK (native addon) only when armed;
 * the caller MUST NOT await it (fire-and-forget) so boot is never blocked.
 *
 * Any failure (missing env, native-addon load failure, init throw) is swallowed
 * — profiling must never crash or degrade the app.
 */
export async function registerPyroscope(): Promise<void> {
  try {
    // Edge/client runtimes: never load the native profiler.
    if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;

    // DARK by default. Unset flag ⇒ the package (and its native addon) is never
    // imported ⇒ genuine zero-cost no-op.
    if (!pyroscopeArmed) return;

    // The push target (the in-cluster profiling-ingest receiver) is supplied by
    // the deployment env, NEVER hard-coded here (public repo — no infra addresses
    // in code). Without it we can't push, so stay dark.
    const serverAddress = process.env.PYROSCOPE_SERVER_ADDRESS;
    if (!serverAddress) {
      console.warn(
        '[pyroscope] PYROSCOPE_ENABLED=true but PYROSCOPE_SERVER_ADDRESS is unset; not arming.'
      );
      return;
    }

    // Dynamic import — the ONLY place the SDK (and its eager native addon) is
    // loaded. A static string literal keeps it traceable by @vercel/nft into the
    // standalone build, and serverExternalPackages keeps it un-bundled.
    const mod = await import('@pyroscope/nodejs');
    const Pyroscope = mod.default;

    // Optional basic-auth (Grafana-Cloud-ready). The in-cluster receiver needs
    // none; only pass when BOTH are provided.
    const basicAuthUser = process.env.PYROSCOPE_BASIC_AUTH_USER;
    const basicAuthPassword = process.env.PYROSCOPE_BASIC_AUTH_PASSWORD;

    // Profile flush interval (default 60000ms). The flush runs a
    // serialize→protobuf-encode→push on the MAIN thread, so on a CPU-ceiling-
    // capped pool it's a periodic on-loop blip. Env-tunable (no code change) so a
    // Stage-2 canary can lengthen it if event-loop-lag p99 shows the flush stall
    // is material at peak. Ignored unless a finite number.
    const flushRaw = process.env.PYROSCOPE_FLUSH_INTERVAL_MS;
    const flushIntervalMs =
      flushRaw && Number.isFinite(Number(flushRaw)) ? Number(flushRaw) : undefined;

    Pyroscope.init({
      serverAddress,
      appName: process.env.PYROSCOPE_APP_NAME ?? 'civitai-dp-prod',
      tags: {
        // Low-cardinality static process tags (bounded set). Enables diff-by-
        // version flamegraphs (baseline old tag vs comparison new tag) and
        // per-pool / per-pod filtering.
        pod: resolvePod(),
        version: process.env.APP_VERSION ?? process.env.IMAGE_TAG ?? 'unknown',
        pool: process.env.SERVICE_NAME ?? 'unknown', // api / ssr / jobs
      },
      wall: {
        // collectCpuTime:true collects actual CPU-time samples (process_cpu:cpu),
        // not just wall time — the metric we rank server-CPU by. The SDK default
        // is FALSE (wall only), so this is required for CPU attribution.
        collectCpuTime: true,
        // 100 Hz (10 ms interval) — the SDK default and the standard, conservative
        // continuous-profiling rate. The V8 sampler runs on a separate thread, so
        // this is low-overhead; validate empirically in the Stage-2 canary.
        samplingIntervalMicros: 10_000,
      },
      ...(flushIntervalMs ? { flushIntervalMs } : {}),
      ...(basicAuthUser && basicAuthPassword ? { basicAuthUser, basicAuthPassword } : {}),
    });

    // start() would ALSO start heap (allocation) profiling — extra overhead we
    // don't want for a CPU-focused rollout. startWallProfiling() runs the wall/cpu
    // sampler ONLY. (It lives on the default export, not as a top-level named
    // export.)
    Pyroscope.startWallProfiling();

    console.log(
      `[pyroscope] armed: wall+cpu profiling -> ${serverAddress} ` +
        `(appName=${process.env.PYROSCOPE_APP_NAME ?? 'civitai-dp-prod'}, ` +
        `pool=${process.env.SERVICE_NAME ?? 'unknown'}, 100Hz, collectCpuTime=true)`
    );
  } catch (err) {
    // e.g. the native addon failing to load. Never crash boot.
    console.error('[pyroscope] failed to arm; continuing without profiling:', err);
  }
}
