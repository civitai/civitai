/**
 * Shared App Blocks build/deploy-lifecycle timing constants.
 *
 * Lives in `shared/` because BOTH sides need the SAME number:
 *   - the owner-facing UI (`~/components/Apps/deploy-status`) decides when a
 *     build/deploy is "stalled" or "stranded", and
 *   - the server (`retriggerBuild` in `publish-request.service`) decides when an
 *     apparently in-flight deploy is stale enough that a moderator may re-fire
 *     the build.
 *
 * A second hardcoded number on either side would silently let the UI offer a
 * retrigger the server rejects (or vice-versa), so this is the single source.
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
