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
 *   - The BUILD states are a hard `notFound` when refused, never a session→login redirect.
 *     State A (the recruiting pitch) needs no user at all: the `appBlocksGetStarted` term
 *     consults only a flag, and a login wall in front of a marketing page is the opposite of
 *     what a recruiting funnel wants. States B and C are unreachable without a session by
 *     construction (`isAppDeveloper` is false without a user, and `blocks.getNavSummary` is a
 *     `protectedProcedure`).
 *   - The ONE login redirect is the assistant's `sign-in` mode: a viewer the App Assistant gate
 *     admits but the build gate does not, arriving signed out. That is what `/apps/assistant`
 *     did before it redirected here, and its bookmarks land here now.
 */
import {
  resolveAppsBuildPageMode,
  type AppsBuildPageFeatureFlags,
} from '~/shared/utils/app-blocks-access';

export type BuildPageAccessResult =
  | { notFound: true }
  | { redirect: { destination: string; permanent: false } }
  | { props: { mode: 'build' } }
  | { assistant: true };

export function resolveBuildPageAccess(args: {
  // The SHARED flag type, derived from `FeatureAccess` — so renaming/removing one of
  // the flags upstream is a compile error here rather than a silent degradation.
  features?: AppsBuildPageFeatureFlags;
  user?: { isModerator?: boolean | null; bannedAt?: Date | null } | null;
  /** The request's own path + query, for the login round trip. */
  resolvedUrl?: string;
}): BuildPageAccessResult {
  const mode = resolveAppsBuildPageMode(args.user, args.features);
  if (mode === 'sign-in')
    return {
      redirect: {
        destination: `/login?returnUrl=${encodeURIComponent(args.resolvedUrl ?? '/apps/build')}`,
        permanent: false,
      },
    };
  if (mode === 'assistant') {
    // A banned account keeps no way into the assistant; `/apps/assistant` sent it home.
    if (args.user?.bannedAt) return { redirect: { destination: '/', permanent: false } };
    return { assistant: true };
  }
  if (mode === 'build') return { props: { mode: 'build' } };
  return { notFound: true };
}
