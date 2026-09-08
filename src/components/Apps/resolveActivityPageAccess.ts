/**
 * SSR access decision for `/apps/activity` (the renamed `/apps/installed`).
 *
 * Pure, React-free and standalone so the GATING INVARIANT is unit-testable in the
 * node-env `unit` project — the tier that actually blocks — without importing the
 * page's React/Mantine/tRPC module graph. Same extraction precedent as
 * `resolveAppsPageAccess.ts` and `resolveBuildPageAccess.ts`, for the same reason.
 *
 * 🔒 GATING INVARIANT (do not violate):
 *   - The FLAG gate is FIRST. It is `canAccessAppsActivity` — the SHARED predicate,
 *     never re-spelled here — so the SSR gate and the page body's client re-check
 *     cannot drift apart.
 *   - `appBlocks || appBlocksPages`, NOT `appBlocks` alone. The old page gated on the
 *     SLOT flag, which refused every viewer whose only app usage is a FULL-PAGE app
 *     (`/apps/run/<slug>`, gated on `appBlocksPages`). Those viewers have activity —
 *     generations, scope-gated API calls, Buzz spends — recorded against them and no
 *     slot install at all, so the old gate was calling the page "your activity" while
 *     refusing the people who had some.
 *   - The SESSION check is SECOND, and it stays a login REDIRECT rather than a 404.
 *     This is a per-viewer account surface: a signed-out visitor with a bookmark has a
 *     coherent next step, unlike an ungated one. Order matters — flag first means an
 *     ungated visitor learns nothing from the response, not even that the route exists.
 */
import {
  canAccessAppsActivity,
  type AppsActivityFeatureFlags,
} from '~/shared/utils/app-blocks-access';

export type ActivityPageAccessResult =
  | { notFound: true }
  | { redirect: { destination: string; permanent: false } }
  | { props: Record<string, never> };

export function resolveActivityPageAccess(args: {
  // The SHARED flag type (derived from `FeatureAccess`) — renaming either flag at GA
  // is a compile error here rather than a silently narrowed gate.
  features?: AppsActivityFeatureFlags;
  /** The resolved session user, or null/undefined when signed out. */
  user?: { id?: number } | null;
  /** Where to send a signed-out viewer. Built by the caller from `getLoginLink`. */
  loginDestination: string;
}): ActivityPageAccessResult {
  // 🔒 FLAG GATE FIRST — before anything is learned about the session.
  if (!canAccessAppsActivity(args.features)) return { notFound: true };
  if (!args.user) {
    return { redirect: { destination: args.loginDestination, permanent: false } };
  }
  return { props: {} };
}
