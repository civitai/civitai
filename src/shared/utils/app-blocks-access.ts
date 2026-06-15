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
 * When external-developer submission opens (W11), widen THIS predicate — it
 * is the single flip-point for the whole developer funnel. Do NOT re-inline
 * `isModerator` checks in the individual `getServerSideProps` resolvers or
 * the nav hook; route them all through here.
 *
 * NOTE: the moderator-only REVIEW surface (`/apps/review`) is conceptually
 * always-moderator and is NOT part of this developer flip — it gates on
 * `isModerator` directly, not on `isAppDeveloper`.
 *
 * Pure (no server/client-only imports) so it's usable from both the
 * `getServerSideProps` resolvers and the client-side nav hook.
 */
export function isAppDeveloper(user: { isModerator?: boolean | null } | null | undefined): boolean {
  return !!user?.isModerator;
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
