/**
 * SSR access decision for the consolidated BUILD surface (`/apps/build`). Pure,
 * React-free, and standalone so the GATING INVARIANT is unit-testable in the node-env
 * unit project without importing the page's React/Mantine module graph. Mirrors
 * `resolveAppsPageAccess` / the retired `resolveGetStartedAccess`.
 *
 * 🔒 GATING INVARIANT — do not violate:
 *   - The decision is NOT written here. It is {@link resolveAppsBuildPageMode} in
 *     `~/shared/utils/app-blocks-access`, composed from `canAccessAppsBuild` and
 *     `canAccessAppAssistant` — the SAME function the `Build` rail row calls. That sharing is
 *     the entire point of this consolidation: `/apps/get-started`, `/apps/submit`,
 *     `/apps/mine` and `/apps/assistant` each had a page gate and a tab gate written out
 *     separately, and they disagreed — a store-visible non-author was offered tabs into two
 *     404s (PR #4668, #3899). One function cannot disagree with itself.
 *   - A viewer that gate refuses never reaches the build surface. What they get instead:
 *       • signed in (not banned): the `request` view — the pitch and the Request access panel,
 *         nothing else from the build surface. "Request access" is how a person gets builder
 *         access, so it must be reachable by exactly the people the gate refuses; a 404 there
 *         made the form unreachable for everyone who needed it.
 *       • signed out, with `?request-access=1`: sent to sign in and back to that URL, where they
 *         land in one of the cases above.
 *       • otherwise (signed out without the param, or banned): `notFound`, as before.
 *     This fallback lives HERE, not in `resolveAppsBuildPageMode`, on purpose: that function
 *     is also the rail's Build row, and the request view is not a store surface — a viewer
 *     with no store access has no `/apps` rail to put the row in.
 *   - An ADMITTED signed-out viewer is never sent to log in. State A (the recruiting pitch)
 *     needs no user at all: the `appBlocksGetStarted` term consults only a flag, and a login
 *     wall in front of a marketing page is the opposite of what a recruiting funnel wants.
 *     States B and C are unreachable without a session by construction (`isAppDeveloper` is
 *     false without a user, and `blocks.getNavSummary` is a `protectedProcedure`). The
 *     assistant mode needs a session too, and its flag cannot be on for a signed-out viewer
 *     (see `resolveAppsBuildPageMode`).
 */
import {
  resolveAppsBuildPageMode,
  type AppsBuildPageFeatureFlags,
} from '~/shared/utils/app-blocks-access';
import { getLoginLink } from '~/utils/login-helpers';

export type BuildPageAccessResult =
  | { notFound: true }
  | { redirect: { destination: string; permanent: false } }
  | { props: { mode: 'build' } }
  | { props: { mode: 'request' } }
  | { assistant: true };

export function resolveBuildPageAccess(args: {
  // The SHARED flag type, derived from `FeatureAccess` — so renaming/removing one of
  // the flags upstream is a compile error here rather than a silent degradation.
  features?: AppsBuildPageFeatureFlags;
  user?: { isModerator?: boolean | null; bannedAt?: Date | null } | null;
  /** The request carries `?request-access=1` (the deep link to the Request access form). */
  wantsRequestAccess?: boolean;
  /** Where sign-in returns to: the requested URL, param included. */
  returnUrl?: string;
}): BuildPageAccessResult {
  const mode = resolveAppsBuildPageMode(args.user, args.features);
  if (mode === 'assistant') {
    // A banned account has no way into the assistant: it is sent home.
    if (args.user?.bannedAt) return { redirect: { destination: '/', permanent: false } };
    return { assistant: true };
  }
  if (mode === 'build') return { props: { mode: 'build' } };
  if (args.user) {
    if (args.user.bannedAt) return { notFound: true };
    return { props: { mode: 'request' } };
  }
  if (args.wantsRequestAccess && args.returnUrl)
    return {
      redirect: {
        destination: getLoginLink({ returnUrl: args.returnUrl, reason: 'perform-action' }),
        permanent: false,
      },
    };
  return { notFound: true };
}
