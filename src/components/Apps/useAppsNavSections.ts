import type { AppsNavContext, AppsNavSummary, AppsSection } from '~/components/Apps/apps-sections';
import {
  EMPTY_APPS_NAV_SUMMARY,
  NO_APPS_NAV_CAPABILITIES,
  visibleAppsSections,
} from '~/components/Apps/apps-sections';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useIsClient } from '~/providers/IsClientProvider';
import { trpc } from '~/utils/trpc';
import {
  canAccessAppsBuild,
  hasAppsStoreAccess,
  isAppDeveloper,
} from '~/shared/utils/app-blocks-access';

/**
 * The `/apps/*` nav's DATA CONTAINER — everything the old `AppsSubNav` component did
 * before it rendered a single tab, lifted into a hook.
 *
 * 🔴 WHY A HOOK AND NOT A COMPONENT. `AppsPageLayout` has to know how many sections
 * qualify BEFORE it lays anything out: below two it renders no rail at all and the body
 * takes the full container (the `< 2` collapse, carried over from the tab strip). A
 * component that decided that internally and returned `null` would leave the layout
 * holding a 276px gap for chrome that rendered nothing.
 *
 * Gated on `hasAppsStoreAccess(features)` — the SAME rule `resolveAppsPageAccess`
 * enforces. It carried an extra `|| features.appBlocksGetStarted` term until the
 * `/apps/build` consolidation; see the gate itself for the proof that dropping it is a
 * no-op, and for the hydration argument.
 *
 * 🔴 THE `<2` COLLAPSE STILL FIRES, FOR THE SAME COHORT AS BEFORE: a store-visible
 * non-author with no installs and no `appBlocksGetStarted` qualifies for Marketplace
 * ALONE and gets no chrome. Unchanged by the rail move.
 *
 * 🔴 THIS GATE USED TO READ `features.appBlocks` ALONE while the page it sits on
 * granted access on `appListings || appBlocks`. The two could therefore disagree:
 * a cohort holding `app-listings` WITHOUT `app-blocks-enabled` would load `/apps`
 * successfully and get NO sub-navigation. That is not reachable today — in Flipt
 * `app-listings` and `app-blocks-enabled` roll out to the SAME two segments,
 * `moderators` and `app-dev-testers` — but `app-listings` exists precisely so the
 * catalog can widen INDEPENDENTLY of the block runtime, so the disagreement is one
 * segment edit away. Both gates now call one predicate.
 */
export function useAppsNavSections(): AppsSection[] {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  // 🔴 HYDRATION-SAFE SECTION SET. The CONDITIONAL sections are driven by the
  // client-only `getNavSummary` query, whose data is present in the CLIENT's very first
  // render but ABSENT during SSR (tRPC runs with `ssr: false`, so the server always
  // renders `EMPTY_APPS_NAV_SUMMARY` = the always-on sections). Rendering the resolved
  // summary on the first client paint therefore produced a DIFFERENT section set than
  // the server HTML (e.g. 2 vs 6 for a user with
  // installs/submissions/approved-apps/reviewer status) — a React hydration
  // mismatch (#418/#425) that bails hydration of the ENTIRE /apps page root,
  // leaving every /apps page un-hydrated and inert (dead buttons, queries that
  // never fire). Gate on `useIsClient()` so the server AND the first client paint
  // both render the deterministic always-on set; the conditional sections reveal only
  // AFTER mount, once hydration has already matched.
  const isClient = useIsClient();

  // 🔴 DELIBERATELY *NOT* `hasAppsStoreAccess` — this one stays on `appBlocks`
  // alone, and that is not an oversight. A query gate must mirror the gate on the
  // PROCEDURE it calls, not the gate on the page it renders in. `blocks.getNavSummary`
  // is `protectedProcedure.use(enforceAppBlocksFlag)` (blocks.router.ts), i.e. the
  // strict `app-blocks-enabled` check — and because it is a QUERY the middleware
  // short-circuits rather than throwing, returning the ALL-FALSE summary without
  // running a single DB read. So for an `app-listings`-only viewer, widening this
  // `enabled` would buy a guaranteed round-trip to a guaranteed all-false answer.
  //
  // ⚠️ THE OLD JUSTIFICATION HERE IS NOW FALSE AND IS CORRECTED RATHER THAN DELETED,
  // because it is the plausible-sounding reason someone will decide this gate is
  // airtight. It read: the conditional sections "all point at pages that themselves 404
  // without `appBlocks`, so all-false is also the CORRECT set for that viewer."
  // `/apps/activity` NO LONGER 404s without `appBlocks` — it gates on
  // `canAccessAppsActivity` = `appBlocks || appBlocksPages`. So for a viewer holding
  // `appBlocksPages` but not `appBlocks`, all-false is NOT the correct set: the page
  // would serve them and this gate hides the only route to it. That is the residual
  // narrowness recorded on the Activity row, and it is the SAFE direction (an
  // unreachable page, not a link into a 404) — but do not re-derive the retired claim as
  // proof that no gap exists. Invites / Revenue / Review are still `appBlocks`-gated
  // pages, so the sentence remains true for them. If the server proc ever moves to
  // `enforceAppListingsReadFlag` — or gains `appBlocksPages` — move this with it.
  const { data } = trpc.blocks.getNavSummary.useQuery(undefined, {
    enabled: !!features.appBlocks && !!currentUser,
    staleTime: 60_000,
  });

  // 🔴 THE `|| features.appBlocksGetStarted` TERM WAS REMOVED, AND THAT IS PROVABLY A
  // NO-OP RATHER THAN A JUDGEMENT CALL. It existed so the old "Build apps" tab could
  // render for the `appBlocksGetStarted`-WITHOUT-store cohort, who otherwise never got a
  // bar. After the consolidation EVERY row in `appsSections` implies store access:
  //   • Build      — `canAccessAppsBuild` has `hasAppsStoreAccess` as a hard AND;
  //   • Marketplace— `c.canSeeStore` IS `hasAppsStoreAccess`;
  //   • Activity / Invites / Revenue / Review — all driven by `getNavSummary`, whose
  //     `enabled` requires `features.appBlocks`, and `appBlocks` is one of the three
  //     disjuncts of `hasAppsStoreAccess`, so the summary is all-false without it.
  // So a viewer this gate would have admitted on the second term alone qualifies for ZERO
  // rows and the `< 2` collapse returns an empty set a moment later regardless.
  //
  // ⚠️ THE JUSTIFICATION FOR KEEPING IT WAS DRAFTED AND WAS WRONG — recorded because it is
  // the plausible-sounding reason someone will re-add it. It ran: "Invites keys on
  // `c.isAuthor`, so an author with no store flags would lose their invite entry." That
  // author does not HAVE one: `hasPendingInvites` comes from a query gated on
  // `appBlocks`, so it is false for them either way. Check what actually feeds a row
  // before arguing a container gate protects it.
  //
  // 🔴 SAFE ON THE FIRST PAINT. The term is SSR-seeded and FROZEN: resolved server-side in
  // `_app`'s `getInitialProps` (`getFeatureFlagsAsync({ user: session.user, … })`, Flipt
  // included), serialized into `pageProps.flags`, frozen by `useState(initialFlags)` in
  // `FeatureFlagsProvider`, and none of the three store flags is `toggleable: true` — so
  // `computeUserFeatureFlagsOverlay` never emits them and the client
  // `user.getFeatureFlags` overlay cannot move them.
  if (!hasAppsStoreAccess(features)) return [];

  const summary: AppsNavSummary = isClient
    ? data ?? EMPTY_APPS_NAV_SUMMARY
    : EMPTY_APPS_NAV_SUMMARY;

  // 🔴 NOT gated on `useIsClient()` — deliberately, and verified against the
  // incident above rather than assumed. All THREE inputs are SSR-seeded and FROZEN,
  // so this value is byte-identical on the server render and the first client
  // render, which is the whole condition for hydration safety:
  //   • `features.appBlocksAuthor` and `features.appBlocksGetStarted` are both
  //     resolved server-side in `_app`'s `getInitialProps`, serialized into
  //     `pageProps.flags`, and frozen by `useState(initialFlags)` in
  //     `FeatureFlagsProvider`. NEITHER is a `toggleable: true` flag, so
  //     `computeUserFeatureFlagsOverlay` never emits them and the client
  //     `user.getFeatureFlags` overlay cannot move them.
  //   • `currentUser.isModerator` rides `SessionProvider`'s `useState(initial)`,
  //     seeded from the same SSR `pageProps.session`. When that seed is
  //     `undefined` (auth cookie present, session unresolved) the SERVER also
  //     rendered without a user, so the first client paint still matches — the
  //     session only arrives in a LATER render, post-hydration.
  // Contrast `getNavSummary` above, which really is client-only and therefore
  // really does need the `isClient` deferral.
  //
  // 🔴 `canBuild` IS NOT RE-DERIVED HERE — it is the SHARED `canAccessAppsBuild`, the
  // same call `resolveBuildPageAccess` makes in the page's `getServerSideProps`. That is
  // the fix for the defect class this surface keeps hitting: a nav predicate written
  // separately from its page's gate WILL drift, and both #3899 and PR #4668 were that
  // drift caught late. Do not "simplify" this to a flag read.
  //
  // 🔴 IT IS NOT SESSION-SCOPED, unlike `isAuthor`, and that asymmetry is deliberate
  // rather than an oversight. `isAppDeveloper` reads `isModerator`, so `isAuthor`
  // collapses to `false` without a session; `canAccessAppsBuild` takes the user as an
  // argument and handles the anon case ITSELF (the `appBlocksGetStarted` term consults
  // no user), so folding it into the `currentUser` branch would hide the entry from a
  // logged-out viewer the PAGE would happily serve state A to.
  const context: AppsNavContext = {
    isAuthor: currentUser
      ? isAppDeveloper(currentUser, { appBlocksAuthor: features.appBlocksAuthor })
      : NO_APPS_NAV_CAPABILITIES.isAuthor,
    canBuild: canAccessAppsBuild(currentUser, features),
    canSeeStore: hasAppsStoreAccess(features),
  };

  return visibleAppsSections(summary, context);
}
