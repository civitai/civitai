import fs from 'node:fs';

/**
 * Liveness heartbeat for an EXEC liveness probe.
 *
 * The api pods run one Node process = one JS thread. Under CPU saturation the
 * event loop pins, and an httpGet liveness probe (served by that SAME loop)
 * times out — so the kubelet SIGKILLs a pod that is busy-but-ALIVE, which
 * cold-restarts it and AMPLIFIES the wave (cold-start module compilation re-pins
 * the loop → fails again → cascade). See the liveness history in
 * datapacket-talos `deployment-api.yaml`. The prior mitigation just widened the
 * probe tolerance to ~15min — a band-aid on a signal (probe-response latency)
 * that fundamentally can't tell "busy" from "dead".
 *
 * This writes the current epoch-SECONDS to a file every 2s, ON the event loop.
 * A k8s EXEC liveness probe then checks the file's staleness, e.g.:
 *   sh -c '[ $(( $(date +%s) - $(cat /tmp/heartbeat) )) -lt <threshold> ]'
 * A pinned-but-PROGRESSING loop still flushes this 2s timer well within the
 * threshold → stays alive (no false kill). A TRULY wedged loop (deadlock or a
 * runaway synchronous block) stops updating the file → it goes stale → the pod
 * is reaped. That is the correct "tolerate busy, detect dead" semantics, with a
 * real loop-liveness signal instead of probe-latency tolerance tuning.
 *
 * Epoch-SECONDS (not ms) because the runner image is node:20-alpine → busybox
 * `date` has no `%N`; the probe reads seconds with `date +%s`.
 *
 * Implementation notes:
 * - SYNC write: the whole write completes inside the timer callback, so the file
 *   mtime/contents prove the loop actually executed this tick. An async write
 *   would dispatch to the libuv threadpool (UV_THREADPOOL_SIZE=16) where it could
 *   lag behind other I/O even while the loop is alive — masking loop liveness.
 *   The payload is ~10 bytes to /tmp; cost is sub-millisecond every 2s.
 * - Best-effort: a transient write error is swallowed (one missed tick is far
 *   inside any sane probe threshold) so the heartbeat can never crash the process.
 * - The timer is `unref()`d so it never keeps the process alive on its own.
 */
const HEARTBEAT_FILE = process.env.LIVENESS_HEARTBEAT_FILE ?? '/tmp/heartbeat';
const HEARTBEAT_INTERVAL_MS = 2000;

let started = false;
let loggedError = false;

export function registerLivenessHeartbeat() {
  if (started) return;
  started = true;

  const write = () => {
    try {
      fs.writeFileSync(HEARTBEAT_FILE, String(Math.floor(Date.now() / 1000)));
      loggedError = false;
    } catch (err) {
      // best-effort — never throw from the heartbeat. But a PERSISTENT failure
      // (read-only /tmp, disk full) makes the file go stale, which under the
      // phase-2 exec liveness probe REAPS the pod — and this log is the only
      // in-app signal for that. Log once at the start of each failure streak
      // (reset on the next success) so it's greppable without spamming.
      if (!loggedError) {
        loggedError = true;
        console.error(`[liveness-heartbeat] failed to write ${HEARTBEAT_FILE}:`, err);
      }
    }
  };

  // Write immediately so the file exists before the startup probe passes and
  // liveness (which gates behind startup) begins checking it.
  write();
  const timer = setInterval(write, HEARTBEAT_INTERVAL_MS);
  timer.unref();
}
