/**
 * App Blocks — developer-surface access gate.
 *
 * Single source of truth for who can reach the app-DEVELOPER surfaces
 * (`/apps/submit`, `/apps/my-submissions`, `/apps/revenue`, and the
 * per-app `/apps/[appBlockId]/revenue`). These are the surfaces for people
 * who BUILD and earn from apps, as opposed to the consumer surfaces
 * (`/apps`, `/apps/installed`) which any user with `features.appBlocks`
 * can use.
 *
 * Today = moderators only (pre-GA). This mirrors the existing `/apps/submit`
 * gate: submission isn't open to external developers yet, so the earnings
 * dashboard and submission history are equally moderator-only to keep the
 * developer funnel coherent (you can't have revenue from an app you can't
 * submit).
 *
 * When external-developer submission opens (W11), widen THIS predicate to
 * govern every CLIENT/SSR developer gate at once — the page `getServerSideProps`
 * resolvers, the nav hook, and the marketplace "Submit App" CTAs all route
 * through it (do NOT re-inline `isModerator` checks; that's the incoherence this
 * file exists to prevent).
 *
 * ⚠️ This is NOT the only thing to flip. The data behind these surfaces is served
 * by `moderatorProcedure`s — `blocks.getMyRevenue`, `getMyApps`,
 * `listMyPublishRequests`, `withdrawPublishRequest`, and the `submitVersion`
 * ModEndpoint. Widening this predicate alone lets a non-mod developer PAST the
 * page gate only to have every query/mutation 403 (a worse UX than today's clean
 * 404). At W11 those server procs MUST widen in lockstep — ideally by replacing
 * `moderatorProcedure` on them with a shared `appDeveloperProcedure` so the
 * server gate has a single flip-point too.
 *
 * NOTE: the moderator-only REVIEW surface (`/apps/review`) is conceptually
 * always-moderator and is NOT part of this developer flip — it gates on
 * {@link isAppReviewer} (which stays moderator-only), not `isAppDeveloper`.
 *
 * Pure (no server/client-only imports) so it's usable from both the
 * `getServerSideProps` resolvers and the client-side nav hook.
 */
export function isAppDeveloper(
  user: { isModerator?: boolean | null } | null | undefined,
  // Developer soft-launch (Phase B): the `appBlocksAuthor` capability (Flipt
  // `app-blocks-author`, static fallback mod-only) widens the developer surfaces
  // to a curated non-mod cohort. Callers thread the resolved flag from
  // `features.appBlocksAuthor` (SSR resolver) / `useFeatureFlags()` (client).
  // OPTIONAL + defaulting undefined so pre-existing callers keep the mod-only
  // meaning unchanged (no silent widening); moderators stay a hard floor via the
  // `isModerator ||` so they never lose access regardless of Flipt config.
  opts?: { appBlocksAuthor?: boolean }
): boolean {
  return !!user?.isModerator || !!opts?.appBlocksAuthor;
}

/**
 * App Blocks — moderator REVIEW-surface access gate (`/apps/review`).
 *
 * Distinct from {@link isAppDeveloper} on purpose: reviewing OTHER people's
 * submitted apps is a moderator action and stays moderator-only even after
 * external-dev submission opens (W11) — at which point `isAppDeveloper` widens
 * but this MUST NOT. Kept as its own named predicate (rather than a raw
 * `isModerator` check in `review.tsx`) so the two gates are greppable and a
 * future "widen the developer gate" change can't accidentally sweep the
 * reviewer surface along with it.
 */
export function isAppReviewer(user: { isModerator?: boolean | null } | null | undefined): boolean {
  return !!user?.isModerator;
}
