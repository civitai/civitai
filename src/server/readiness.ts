import { getWarmState, isWarm, type WarmState } from '~/server/warmup';
import { getHeartbeatAgeMs } from '~/server/liveness-heartbeat-state';
import { isDraining } from '~/server/drain-state';

// Pod-local readiness, served by /api/readyz.
//
// Answers one question: should THIS pod get traffic instead of its siblings? So it reads only
// in-process state and makes no network call. A dependency outage hits every pod at once, and
// marking all of them unready for it turns a partial outage into a full one; dependency checks
// belong in /api/ready (startup gate) and /api/health (diagnostics), which are unchanged.
//
// Every input is read from state pinned on `globalThis` (warmup.ts, liveness-heartbeat-state.ts,
// drain-state.ts). The writers run from instrumentation, which Next bundles separately from the
// API routes, so state held in a module-level variable would not be visible here.

/**
 * The heartbeat ticks every 2s. An age past this means the event loop went this long without
 * running a timer, or the heartbeat stopped: either way the pod should not take new traffic.
 */
export const READYZ_HEARTBEAT_MAX_AGE_MS = 15_000;

export type NotReadyReason = 'cold' | 'heartbeat-missing' | 'heartbeat-stale' | 'draining';

export type Readiness = {
  ready: boolean;
  reasons: NotReadyReason[];
  warmState: WarmState;
  heartbeatAgeMs: number | null;
};

export function evaluateReadiness(now = Date.now()): Readiness {
  const reasons: NotReadyReason[] = [];
  if (!isWarm()) reasons.push('cold');
  const heartbeatAgeMs = getHeartbeatAgeMs(now);
  if (heartbeatAgeMs === null) reasons.push('heartbeat-missing');
  else if (heartbeatAgeMs >= READYZ_HEARTBEAT_MAX_AGE_MS) reasons.push('heartbeat-stale');
  if (isDraining()) reasons.push('draining');
  return { ready: reasons.length === 0, reasons, warmState: getWarmState(), heartbeatAgeMs };
}
