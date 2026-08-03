/**
 * Shared App Blocks build/deploy-lifecycle timing constants + the pure predicates
 * derived from them.
 *
 * Lives in `shared/` because BOTH sides need the SAME number:
 *   - the owner-facing UI (`~/components/Apps/deploy-status`) decides when a
 *     build/deploy is "stalled" or "stranded",
 *   - the server (`retriggerBuild` in `publish-request.service`) decides when an
 *     apparently in-flight deploy is stale enough that a moderator may re-fire
 *     the build, and
 *   - the CLI-facing REST surface (`/api/v1/blocks/submissions`) decides whether
 *     an approved submission is actually SERVING (`liveUrl`).
 *
 * A second hardcoded number on any side would silently let the UI offer a
 * retrigger the server rejects (or hand a CLI a `liveUrl` for an app that never
 * built), so this is the single source.
 */

/**
 * A build/deploy that hasn't advanced in this long is treated as STALLED: the
 * fire-and-forget apply watcher was likely lost to a civitai-web pod restart
 * (build-callback.ts documents this self-heal-on-next-build window). Sits
 * COMFORTABLY above the build pipeline's own ceiling — the Tekton pipeline
 * timeout is 20m EXECUTION plus queue time on the build node — so a legitimately
 * slow/queued build is never mislabeled.
 */
export const DEPLOY_STALE_AFTER_MS = 45 * 60 * 1000;

/**
 * Grace window for an APPROVED request whose `deploy_state` is still NULL.
 *
 * `approveRequest` writes `status='approved'` (+ `forgejo_commit_sha`) and only
 * THEN calls `markRequestDeployState(..., 'building')`, so there is a genuine —
 * but sub-second — window where an approved row legitimately has a null deploy
 * state. Within this grace window the UI keeps polling and renders exactly as it
 * always has; past {@link DEPLOY_STALE_AFTER_MS} with a still-null state the row
 * is STRANDED (the build never fired — e.g. `triggerBuild` threw after the
 * approve was already durable) and is surfaced as such.
 *
 * Deliberately much smaller than the stale threshold: nothing is going to write
 * the state minutes later, so polling past this is pure waste.
 */
export const DEPLOY_PENDING_GRACE_MS = 2 * 60 * 1000;

/**
 * When `deploy_state` tracking began — the moment after which a NULL deploy state
 * on an APPROVED row stopped being normal.
 *
 * The column was added by the `20260615130000_app_blocks_deploy_state` migration
 * and `approveRequest` has written `'building'` ever since. So:
 *   - approved BEFORE this instant + null state  → LEGACY. The lifecycle simply
 *     wasn't recorded; the app genuinely deployed and is serving.
 *   - approved AFTER this instant + null state   → the build never started (the
 *     STRANDED signature) or has not been confirmed yet. NOT serving.
 *
 * That distinction is the ONLY thing separating the two null cases — they are
 * byte-identical in the row otherwise — so it has to be an explicit epoch rather
 * than something derived. Deliberately the migration's own date (UTC midnight),
 * i.e. slightly EARLIER than the deploy, so the classification errs toward
 * "legacy / serving" and can never regress a real pre-feature row.
 */
export const DEPLOY_STATE_TRACKING_EPOCH_MS = Date.UTC(2026, 5, 15); // 2026-06-15T00:00:00Z

/** Row shape the shared deploy predicates read. Dates or ISO strings both work. */
export type ApprovedDeployProjection = {
  status: string;
  deployState: string | null | undefined;
  deployUpdatedAt?: Date | string | null;
  reviewedAt?: Date | string | null;
};

/** Milliseconds for a Date | ISO string, or `null` when absent/unparseable. */
export function deployTimestampMs(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Is this publish request's version ACTUALLY SERVING at `https://<slug>.civit.ai/`?
 *
 * 🔴 The predicate behind `liveUrl` on `/api/v1/blocks/submissions` — the surface
 * `civitai app status` reads. Reporting a version as live when it never built
 * re-creates exactly the invisible-failure this whole feature exists to remove:
 * the CLI would print a working-looking URL for an app that 404s.
 *
 * `'live'` is the only positive deploy state. The subtlety is `null`, which covers
 * TWO opposite realities:
 *   - LEGACY — approved before {@link DEPLOY_STATE_TRACKING_EPOCH_MS}, or carrying
 *     a `deployUpdatedAt` that proves the lifecycle did run at some point. These
 *     genuinely deployed and MUST keep their `liveUrl`.
 *   - NEVER BUILT — approved in the tracked era with no transition ever recorded:
 *     either still inside the approve→build window or STRANDED past
 *     {@link DEPLOY_STALE_AFTER_MS}. Not serving, so no `liveUrl`.
 *
 * Fails toward "serving" whenever it cannot prove otherwise (no `reviewedAt`
 * anchor at all), so the change can only ever REMOVE a URL that was wrong, never
 * remove one that was right.
 *
 * Takes no `now`: BOTH tracked-era null cases — still inside the approve→build
 * window, and stranded long past it — are equally "not serving", so the answer
 * does not depend on the clock. Only {@link isStrandedApprovedDeploy}, which
 * separates those two, needs one.
 */
export function isApprovedAndServing(row: ApprovedDeployProjection): boolean {
  if (row.status !== 'approved') return false;
  if (row.deployState === 'live') return true;
  // Any other non-null state — building / deploying / failed / preview-* — is by
  // definition not a serving production version.
  if (row.deployState !== null && row.deployState !== undefined) return false;

  // --- null deploy state: legacy vs never-built ---
  // A recorded transition means the lifecycle DID run (pre-feature rows that ever
  // moved), so treat it as the legacy serving case.
  if (deployTimestampMs(row.deployUpdatedAt) != null) return true;
  const reviewed = deployTimestampMs(row.reviewedAt);
  if (reviewed == null) return true; // no anchor to judge by — keep the old assumption
  if (reviewed < DEPLOY_STATE_TRACKING_EPOCH_MS) return true; // LEGACY pre-tracking approval
  return false; // tracked era, nothing ever started: in-flight-unconfirmed or STRANDED
}

/**
 * The STRANDED signature specifically: a tracked-era approval whose build never
 * started and is now past {@link DEPLOY_STALE_AFTER_MS} — nothing is running and
 * nothing ever will without a moderator re-trigger. A strict subset of
 * `!isApprovedAndServing` (which also covers the still-fresh approve→build
 * window), and it deliberately excludes the LEGACY null case.
 */
export function isStrandedApprovedDeploy(
  row: ApprovedDeployProjection,
  now: number = Date.now()
): boolean {
  if (isApprovedAndServing(row)) return false;
  if (row.status !== 'approved') return false;
  if (row.deployState !== null && row.deployState !== undefined) return false;
  const reviewed = deployTimestampMs(row.reviewedAt);
  if (reviewed == null) return false;
  return now - reviewed > DEPLOY_STALE_AFTER_MS;
}
