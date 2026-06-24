/**
 * SSR access decision for the /apps marketplace (F-E E1). Pure, React-free, and
 * standalone so the GATING INVARIANT is unit-testable in the node-env unit
 * project without importing the page's React/Mantine module graph.
 *
 * 🔒 GATING INVARIANT (F-E E1 — do not violate):
 *   - The `features.appBlocks` flag gate is FIRST and is the ONLY access
 *     control. A logged-out / non-mod user does NOT satisfy the Flipt
 *     `app-blocks-enabled` mod segment, so `features.appBlocks` is false for
 *     them → notFound. The page stays dark for real anon/non-mod users until
 *     the segment is widened at launch (a separate, product-signed-off step).
 *   - There is intentionally NO separate `session→login` redirect: behind the
 *     flag gate, a session-less request RENDERS the marketplace read-only
 *     instead of bouncing to /login. This is the "anon-capable but dark" read
 *     path — reachable by a real anon user ONLY once the flag grants access
 *     (mods-only today). (As of App Blocks GA the public catalog + per-app detail
 *     pages are INDEXABLE — `deIndex` was dropped from their <Meta>; per-USER
 *     pages like /apps/installed and /apps/revenue stay deIndexed.)
 */
export type AppsPageAccessResult = { notFound: true } | { props: Record<string, never> };

export function resolveAppsPageAccess(args: {
  features?: { appBlocks?: boolean } | null;
}): AppsPageAccessResult {
  // Flag gate FIRST and ONLY. No session check — the dark anon path renders
  // behind the flag; access is decided entirely by features.appBlocks.
  if (!args.features?.appBlocks) return { notFound: true };
  return { props: {} };
}
