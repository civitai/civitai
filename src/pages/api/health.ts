import type { NextApiRequest, NextApiResponse } from 'next';
import { isProd } from '~/env/other';
import { runHealthChecks, type CheckKey } from '~/server/health/dependency-checks';
import { ProbeEndpoint } from '~/server/utils/endpoint-helpers';
import { getRandomInt } from '~/utils/number-helpers';

// The check set itself (checks, disable lists, timeouts, deadline, metrics) lives in
// ~/server/health/dependency-checks so the background metrics loop can run the very same code.
// Re-exported for the existing importers of this route module.
export { runHealthChecks } from '~/server/health/dependency-checks';
export type { CheckKey } from '~/server/health/dependency-checks';

// Readiness probes call /api/health every few seconds. A run in which EVERY check passed is reused
// for this long, so a dependency that breaks just after a clean run is noticed up to this much
// later. Anything less than a clean sweep is never reused: a failing or soft-failing dependency, a
// deadline overrun or an aborted run all re-run the full suite on the next probe, so recovery is
// seen as fast as before.
const CLEAN_RUN_REUSE_MS = 10_000;
let lastCleanRun: { startedAt: number; results: Record<CheckKey, boolean> } | undefined;
// Overlapping probes can finish out of order: a slow clean run must not overwrite a failure that a
// later-started run already reported.
let lastNonCleanFinishedAt = -Infinity;

/** Test-only: forget any reusable run, so one test can never be answered by another's. */
export function resetHealthCheckReuseForTests() {
  lastCleanRun = undefined;
  lastNonCleanFinishedAt = -Infinity;
}

export async function runHealthChecksReusingCleanRun(
  ...args: Parameters<typeof runHealthChecks>
): ReturnType<typeof runHealthChecks> {
  const [signal] = args;
  // Monotonic, so a wall-clock step backwards cannot keep a stale verdict fresh.
  const startedAt = performance.now();
  if (lastCleanRun && startedAt - lastCleanRun.startedAt < CLEAN_RUN_REUSE_MS) {
    return { healthy: true, results: { ...lastCleanRun.results }, deadlineTimedOut: false };
  }

  const run = await runHealthChecks(...args);
  // Every check true implies `healthy`, and a deadline overrun leaves an unsettled check false.
  const clean =
    !signal.aborted &&
    Object.keys(run.results).length > 0 &&
    Object.values(run.results).every(Boolean);
  if (!clean) {
    lastNonCleanFinishedAt = performance.now();
    lastCleanRun = undefined;
  } else if (startedAt >= lastNonCleanFinishedAt) {
    lastCleanRun = { startedAt, results: { ...run.results } };
  }
  return run;
}

export default ProbeEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const podname = process.env.PODNAME ?? getRandomInt(100, 999);

  // Create AbortController for all health checks
  // This will be aborted when the client disconnects
  const abortController = new AbortController();
  const { signal } = abortController;

  // Abort all checks when client disconnects
  const onClose = () => {
    if (!isProd) console.log('Health check request cancelled (client disconnected)');
    abortController.abort();
  };
  res.on('close', onClose);

  // Check if already cancelled before starting the expensive checks.
  if (signal.aborted) {
    res.off('close', onClose);
    return;
  }

  const { healthy, results } = await runHealthChecksReusingCleanRun(signal);

  // Clean up the close listener
  res.off('close', onClose);

  // If cancelled, don't send response (connection is already closed)
  if (signal.aborted) {
    return;
  }

  return res.status(healthy ? 200 : 500).json({
    podname,
    version: process.env.version,
    healthy,
    ...results,
  });
});
