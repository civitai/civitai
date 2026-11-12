// The time of the liveness heartbeat's last tick, in ms, for in-process readers (/api/readyz).
// Written by `liveness-heartbeat.ts` on every tick.
//
// Pinned on `globalThis` because the heartbeat is started from instrumentation, which Next
// compiles into a separate bundle from the API routes: a module-level variable written in that
// bundle's copy of this module would never be visible to the route's copy. Same reason, same
// mechanism as the warm state in warmup.ts. Its own module so a reader does not pull in the
// heartbeat's writer and the event-loop watchdog behind it.

declare global {
  // eslint-disable-next-line no-var
  var __civitaiLivenessHeartbeat: { lastBeatMs: number | null } | undefined;
}

const beat = (globalThis.__civitaiLivenessHeartbeat ??= { lastBeatMs: null });

export function recordHeartbeatTick(now = Date.now()) {
  beat.lastBeatMs = now;
}

/** Ms since the heartbeat last ticked, or null when it has never ticked in this process. */
export function getHeartbeatAgeMs(now = Date.now()): number | null {
  return beat.lastBeatMs === null ? null : now - beat.lastBeatMs;
}
