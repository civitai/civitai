/**
 * Pure helpers for the App Blocks build/deploy lifecycle shown on
 * `/apps/my-submissions` (Phase 2). Extracted from the page so the
 * staleness + poll-cadence logic — the part that churned across two
 * audit-fix passes — is unit-testable without React.
 */

export type DeployLifecycleState = 'building' | 'deploying' | 'live' | 'failed' | null;

export type DeployLifecycleRow = {
  status: string;
  deployState: DeployLifecycleState;
  deployUpdatedAt?: string | Date | null;
};

// A build/deploy that hasn't advanced in this long is treated as STALLED: the
// fire-and-forget apply watcher was likely lost to a civitai-web pod restart
// (build-callback.ts documents this self-heal-on-next-build window). Sits
// COMFORTABLY above the build pipeline's own ceiling — the Tekton pipeline
// timeout is 20m EXECUTION plus queue time on the single slow build node — so a
// legitimately slow/queued build is never mislabeled. A stalled row only BACKS
// OFF polling (never stops), so a slow build that finishes past the threshold
// still self-heals to live/failed without a page reload.
export const DEPLOY_STALE_AFTER_MS = 45 * 60 * 1000;

/** An approved request whose code is still being built or deployed. */
export function isInFlightDeploy(s: Pick<DeployLifecycleRow, 'status' | 'deployState'>): boolean {
  return (
    s.status === 'approved' && (s.deployState === 'building' || s.deployState === 'deploying')
  );
}

/**
 * An in-flight row that hasn't transitioned in `DEPLOY_STALE_AFTER_MS` — likely
 * stuck (watcher lost to a pod restart). `now` is injectable for tests.
 */
export function isStaleDeploy(s: DeployLifecycleRow, now: number = Date.now()): boolean {
  if (!isInFlightDeploy(s) || !s.deployUpdatedAt) return false;
  const updated =
    typeof s.deployUpdatedAt === 'string' ? new Date(s.deployUpdatedAt) : s.deployUpdatedAt;
  return now - updated.getTime() > DEPLOY_STALE_AFTER_MS;
}

/**
 * Poll cadence for the submissions query: 5s while an in-flight row is fresh,
 * 30s once every in-flight row looks stalled (back off but DON'T stop, so a
 * slow build still self-heals — the global query config is staleTime:Infinity
 * + refetchOnWindowFocus:false), and stop (`false`) when nothing is in flight.
 */
export function deployRefetchInterval(
  rows: DeployLifecycleRow[],
  now: number = Date.now()
): number | false {
  const inFlight = rows.filter(isInFlightDeploy);
  if (inFlight.length === 0) return false;
  return inFlight.some((s) => !isStaleDeploy(s, now)) ? 5000 : 30000;
}
