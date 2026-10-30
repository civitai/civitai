// In-memory liveness signals for GET /health. Nothing here touches redis or the DB, so the probe itself
// can't hang or flap; it reports what the process has already observed.
//
// Two ways the fan-out worker can be alive but useless, both of which a static 200 hid:
//   - redis: every cache command has failed for a sustained window, with no success in between (a
//     stuck client that only a restart clears). One failed command, or a burst that recovers, is not it.
//   - the poll loop: no row and no tick has finished for the stall window, so nothing is being delivered.
// Both checks apply only once the worker has started in this process: an API-only pod keeps its
// dependency-free 200, because pulling it from service would stop notification creates too.

import { healthRedisFailureWindowMs, healthWorkerStallMs } from '../../env';

export type HealthReport = { ok: true } | { ok: false; reasons: string[] };

export function createHealthTracker({
  redisFailureWindowMs,
  workerStallMs,
  now = () => Date.now(),
}: {
  redisFailureWindowMs: number;
  workerStallMs: number;
  now?: () => number;
}) {
  let redisFailingSince: number | null = null;
  let lastRedisFailureAt: number | null = null;
  let workerStarted = false;
  let lastWorkerProgressAt = 0;

  return {
    recordRedisSuccess() {
      redisFailingSince = null;
      lastRedisFailureAt = null;
    },
    recordRedisFailure() {
      const t = now();
      redisFailingSince ??= t;
      lastRedisFailureAt = t;
    },
    markWorkerStarted() {
      workerStarted = true;
      lastWorkerProgressAt = now();
    },
    markWorkerProgress() {
      lastWorkerProgressAt = now();
    },
    check(): HealthReport {
      if (!workerStarted) return { ok: true };
      const reasons: string[] = [];
      // Span of the failure streak as observed, not time since its start: with no traffic since the
      // last failure we have no evidence the outage lasted any longer.
      if (
        redisFailingSince !== null &&
        lastRedisFailureAt !== null &&
        lastRedisFailureAt - redisFailingSince >= redisFailureWindowMs
      ) {
        reasons.push(
          `redis: every command failed for ${Math.round(
            (lastRedisFailureAt - redisFailingSince) / 1000
          )}s`
        );
      }
      const idleMs = now() - lastWorkerProgressAt;
      if (idleMs >= workerStallMs) {
        reasons.push(`worker: no progress for ${Math.round(idleMs / 1000)}s`);
      }
      return reasons.length ? { ok: false, reasons } : { ok: true };
    },
  };
}

export type HealthTracker = ReturnType<typeof createHealthTracker>;

export const health = createHealthTracker({
  redisFailureWindowMs: healthRedisFailureWindowMs,
  workerStallMs: healthWorkerStallMs,
});
