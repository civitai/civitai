/**
 * SSR access decision for the /apps marketplace (F-E E1). Pure, React-free, and
 * standalone so the GATING INVARIANT is unit-testable in the node-env unit
 * project without importing the page's React/Mantine module graph.
 *
 * 🔒 GATING INVARIANT (F-E E1 + W13 PR-W1a/D8 — do not violate):
 *   - The STORE-VISIBILITY flag gate is FIRST and is the ONLY access control.
 *     W13 repoints it onto the dedicated `appListings` flag with an OR-fallback
 *     to `appBlocks`: access = `features.appListings || features.appBlocks`. A
 *     logged-out / non-mod user satisfies NEITHER (both are mod-segmented today),
 *     so access is false for them → notFound. The store stays dark for real
 *     anon/non-mod users until a segment is widened at launch.
 *   - WHY the OR-fallback: `appListings` (Flipt `app-listings`) does not exist at
 *     merge time, so `features.appListings` resolves via its `availability:['mod']`
 *     Flipt-down fallback (mods only) while `appBlocks` still carries the
 *     app-dev-testers cohort — the OR keeps the CURRENT mods+testers viewers in
 *     verbatim (ZERO behavior change today). A future true-public flip widens
 *     ONLY `app-listings` (this store gate) without flipping the held
 *     block-runtime `app-blocks-enabled` gate.
 *   - There is intentionally NO separate `session→login` redirect: behind the
 *     flag gate, a session-less request RENDERS the marketplace read-only
 *     instead of bouncing to /login. This is the "anon-capable but dark" read
 *     path — reachable by a real anon user ONLY once a flag grants access
 *     (mods-only today). (`deIndex` is kept ON in the page <Meta> so the page is
 *     not crawlable pre-launch.)
 */
export type AppsPageAccessResult = { notFound: true } | { props: Record<string, never> };

export function resolveAppsPageAccess(args: {
  features?: { appBlocks?: boolean; appListings?: boolean } | null;
}): AppsPageAccessResult {
  // Store-visibility gate FIRST and ONLY. No session check — the dark anon path
  // renders behind the flag. W13: dedicated `appListings` flag OR-falling-back to
  // `appBlocks` so the current mods+testers cohort keeps access while
  // `app-listings` doesn't yet exist (zero behavior change today).
  if (!(args.features?.appListings || args.features?.appBlocks)) return { notFound: true };
  return { props: {} };
}
