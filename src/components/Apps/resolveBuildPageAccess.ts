/**
 * SSR access decision for the consolidated BUILD surface (`/apps/build`). Pure,
 * React-free, and standalone so the GATING INVARIANT is unit-testable in the node-env
 * unit project without importing the page's React/Mantine module graph. Mirrors
 * `resolveAppsPageAccess` / the retired `resolveGetStartedAccess`.
 *
 * 🔒 GATING INVARIANT — do not violate:
 *   - The decision is NOT written here. It is {@link canAccessAppsBuild} in
 *     `~/shared/utils/app-blocks-access`, the SAME predicate the `Build` row in
 *     `SUB_NAV_LINKS` calls. That sharing is the entire point of this consolidation:
 *     `/apps/get-started`, `/apps/submit` and `/apps/mine` each had a page gate and a
 *     tab gate written out separately, and they disagreed — a store-visible non-author
 *     was offered tabs into two 404s (PR #4668, #3899). One predicate cannot disagree
 *     with itself.
 *   - It is a hard `notFound`, never a session→login redirect. `/apps/mine` and
 *     `/apps/submit` both bounce a session-less request to `/login`, and that is
 *     correct FOR THEM — they are authoring surfaces that need a user. This page's
 *     DEFAULT state (A, the recruiting pitch) needs no user at all: the
 *     `appBlocksGetStarted` term of the predicate consults only a flag. Redirecting
 *     to login would put a login wall in front of a marketing page, which is the
 *     opposite of what a recruiting funnel wants. A logged-out viewer who is admitted
 *     gets state A; states B and C are unreachable without a session by construction
 *     (`isAppDeveloper` is false without a user, and `blocks.getNavSummary` is a
 *     `protectedProcedure`).
 */
import { canAccessAppsBuild, type AppsBuildFeatureFlags } from '~/shared/utils/app-blocks-access';

export type BuildPageAccessResult = { notFound: true } | { props: Record<string, never> };

export function resolveBuildPageAccess(args: {
  // The SHARED flag type, derived from `FeatureAccess` — so renaming/removing one of
  // the store flags upstream is a compile error here rather than a silent degradation.
  features?: AppsBuildFeatureFlags;
  user?: { isModerator?: boolean | null } | null;
}): BuildPageAccessResult {
  if (!canAccessAppsBuild(args.user, args.features)) return { notFound: true };
  return { props: {} };
}
