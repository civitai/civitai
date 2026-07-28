/**
 * Pure helpers for the App Blocks build/deploy lifecycle shown on
 * `/apps/my-submissions` (Phase 2). Extracted from the page so the
 * staleness + poll-cadence logic — the part that churned across two
 * audit-fix passes — is unit-testable without React.
 */

import {
  DEPLOY_PENDING_GRACE_MS,
  DEPLOY_STALE_AFTER_MS,
} from '~/shared/constants/app-block-deploy.constants';

export type DeployLifecycleState = 'building' | 'deploying' | 'live' | 'failed' | null;

export type DeployLifecycleRow = {
  status: string;
  deployState: DeployLifecycleState;
  deployUpdatedAt?: string | Date | null;
  /** When the moderator decision landed. The anchor for STRANDED detection: a
   *  stranded row has no `deployUpdatedAt` at all (nothing ever transitioned), so
   *  the approval time is the only clock available. */
  reviewedAt?: string | Date | null;
};

// Re-exported so every existing `~/components/Apps/deploy-status` importer keeps
// working. The VALUE now lives in `~/shared/constants/app-block-deploy.constants`
// because the SERVER's retrigger gate must use the identical threshold — two
// hardcoded numbers would let the UI offer a retrigger the server rejects.
export { DEPLOY_PENDING_GRACE_MS, DEPLOY_STALE_AFTER_MS };

function toMs(d: string | Date | null | undefined): number | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** An approved request whose code is still being built or deployed. */
export function isInFlightDeploy(s: Pick<DeployLifecycleRow, 'status' | 'deployState'>): boolean {
  return s.status === 'approved' && (s.deployState === 'building' || s.deployState === 'deploying');
}

/**
 * An in-flight row that hasn't transitioned in `DEPLOY_STALE_AFTER_MS` — likely
 * stuck (watcher lost to a pod restart). `now` is injectable for tests.
 */
export function isStaleDeploy(s: DeployLifecycleRow, now: number = Date.now()): boolean {
  if (!isInFlightDeploy(s)) return false;
  const updated = toMs(s.deployUpdatedAt);
  if (updated == null) return false;
  return now - updated > DEPLOY_STALE_AFTER_MS;
}

/**
 * STRANDED: an APPROVED request whose build never started, so its `deploy_state`
 * is still NULL long after the approval landed.
 *
 * WHY THIS EXISTS — `approveRequest` writes `status='approved'` +
 * `forgejo_commit_sha` and only THEN calls `markRequestDeployState(…,'building')`.
 * If `triggerBuild` throws in between (a transient 502 from the build trigger —
 * this happened in production), the approve is already durable but the deploy
 * state is never written. The row then looks like a healthy green "approved"
 * forever while nothing is building, nothing is deploying, and nothing ever will.
 *
 * DARK-SAFE BY CONSTRUCTION — this is deliberately NOT "deployState is null".
 * A freshly-approved row legitimately has a null state for the sub-second window
 * between the two writes, and every APPROVED ROW FROM BEFORE THE DEPLOY-STATE
 * FEATURE SHIPPED has a permanently-null state. So a row only becomes stranded
 * once it is older than `DEPLOY_STALE_AFTER_MS` **and** carries no
 * `deployUpdatedAt` (any legacy row that has ever transitioned is excluded), and
 * a row with no `reviewedAt` anchor at all is never flagged. Inside the window
 * the row renders exactly as it does today.
 */
export function isStrandedDeploy(s: DeployLifecycleRow, now: number = Date.now()): boolean {
  if (s.status !== 'approved') return false;
  if (s.deployState !== null && s.deployState !== undefined) return false;
  // Any recorded transition means the lifecycle DID run at some point; a null
  // state alongside a transition timestamp is not the stranding signature.
  if (toMs(s.deployUpdatedAt) != null) return false;
  const reviewed = toMs(s.reviewedAt);
  if (reviewed == null) return false;
  return now - reviewed > DEPLOY_STALE_AFTER_MS;
}

/**
 * An approved row whose deploy state has not been written YET but is still within
 * the short post-approval grace window — the genuine race between the approve
 * commit and `markRequestDeployState`. Worth polling briefly; NOT worth polling
 * for the full stale threshold, because past the grace window nothing is going to
 * write it (see {@link isStrandedDeploy}).
 */
export function isAwaitingDeployState(s: DeployLifecycleRow, now: number = Date.now()): boolean {
  if (s.status !== 'approved') return false;
  if (s.deployState !== null && s.deployState !== undefined) return false;
  if (toMs(s.deployUpdatedAt) != null) return false;
  const reviewed = toMs(s.reviewedAt);
  if (reviewed == null) return false;
  return now - reviewed <= DEPLOY_PENDING_GRACE_MS;
}

/** The deploy projection a moderator-queue row carries (see `unifiedReviewRow`). */
export type ModDeployRow = { state: string | null; updatedAt: Date | string | null };

/**
 * CLIENT MIRROR of the server's "approved but not successfully built" gate — the
 * predicate that decides whether the mod queue offers a "Retrigger build" button.
 *
 * 🔴 The AUTHORITY is `assertRetriggerableDeployState` in
 * `~/server/services/blocks/publish-request.service`. This exists only to avoid
 * offering a button the server will reject; it is NOT a security boundary (the
 * server re-checks every condition, plus ownership/supersede/rate limits it
 * cannot see from here). Both read `DEPLOY_STALE_AFTER_MS` from the same shared
 * constant, so the "stalled" cut-off can never drift apart.
 *
 * Allowed: `null` (STRANDED — the build never started) and `'failed'`.
 * Allowed only once stalled: `'building'` / `'deploying'` past
 * `DEPLOY_STALE_AFTER_MS`. Refused: `'live'` and any `preview-*` value.
 */
export function canRetriggerBuild(deploy: ModDeployRow, now: number = Date.now()): boolean {
  const state = deploy.state;
  if (state === null || state === undefined) return true;
  if (state === 'failed') return true;
  if (state === 'live') return false;
  if (state.startsWith('preview-')) return false;
  if (state === 'building' || state === 'deploying') {
    const updated = toMs(deploy.updatedAt);
    if (updated == null) return false;
    return now - updated > DEPLOY_STALE_AFTER_MS;
  }
  return false;
}

/**
 * Poll cadence for the submissions query: 5s while an in-flight row is fresh,
 * 30s once every in-flight row looks stalled (back off but DON'T stop, so a
 * slow build still self-heals — the global query config is staleTime:Infinity
 * + refetchOnWindowFocus:false), and stop (`false`) when nothing is in flight.
 *
 * A just-approved row awaiting its first deploy-state write counts as fresh
 * in-flight for the grace window only, so the badge flips to "building" without a
 * reload. A STRANDED row is deliberately NOT polled — nothing will ever change
 * it, and polling it forever is the bug this replaces.
 */
export function deployRefetchInterval(
  rows: DeployLifecycleRow[],
  now: number = Date.now()
): number | false {
  const inFlight = rows.filter((s) => isInFlightDeploy(s) || isAwaitingDeployState(s, now));
  if (inFlight.length === 0) return false;
  return inFlight.some((s) => !isStaleDeploy(s, now)) ? 5000 : 30000;
}
