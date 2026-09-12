import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

/**
 * App Blocks — developer-surface access gate.
 *
 * Single source of truth for who can reach the app-DEVELOPER surfaces
 * (`/apps/submit`, `/apps/my-submissions`, `/apps/revenue`, and the
 * per-app `/apps/[appBlockId]/revenue`). These are the surfaces for people
 * who BUILD and earn from apps, as opposed to the consumer surfaces
 * (`/apps`, `/apps/activity`) which any user with `features.appBlocks`
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
 * The flag shape {@link canAccessAppsBuild} needs: the three STORE flags (inherited
 * from {@link AppsStoreFeatureFlags}, so they stay derived from `FeatureAccess`) plus
 * the two App-Blocks CAPABILITY flags. Optional + nullable throughout for the same
 * reason the store type is — a Flipt-down flag and an absent `features` object both
 * flow in without a cast, and the predicate fails CLOSED on both.
 */
export type AppsBuildFeatureFlags =
  | (NonNullable<AppsStoreFeatureFlags> &
      Partial<Pick<FeatureAccess, 'appBlocksAuthor' | 'appBlocksGetStarted'>>)
  | null
  | undefined;

/**
 * App Blocks — the `/apps/build` (BUILD) surface gate.
 *
 * 🔒 THE SINGLE SOURCE OF TRUTH for "may this viewer reach the build surface", and it
 * is consumed by exactly TWO callers that MUST agree: the `Build` row in
 * `SUB_NAV_LINKS` (`~/components/Apps/AppsSubNav`) and the page's own SSR gate
 * (`~/components/Apps/resolveBuildPageAccess`, called from `pages/apps/build.tsx`).
 *
 * ## Why one predicate, in one place
 *
 * 🔴 THIS EXISTS BECAUSE THE SPLIT VERSION SHIPPED A LIVE 404, TWICE, AND WAS CAUGHT
 * ONCE. `/apps/submit` and `/apps/mine` both `getServerSideProps`-gate on
 * `features.appBlocksAuthor` + {@link isAppDeveloper} and otherwise return `notFound`,
 * while the sub-nav rows pointing at them were gated on store visibility — so a
 * store-visible NON-author was offered a tab straight into a 404. That exact
 * tab/page mismatch was a deploy-blocking finding on PR #4668 (a tab shown to a
 * cohort its page refused), and before that it is what #3899 was filed for. The
 * fix each time was to re-derive the tab's predicate from the page's; the fix that
 * makes it not come back is for there to be only ONE predicate to derive.
 *
 * So: do NOT re-inline this, and do NOT "simplify" either caller to a subset of it.
 * A row whose visibility rule is spelled out at the row is how this defect is
 * reintroduced. Pinned by `components/Apps/__tests__/appsBuildAccess.test.ts` (the
 * truth table) and `components/Apps/__tests__/appsBuildGateCallSites.test.ts` (the
 * call-site ledger, which fails if either caller stops routing through here).
 *
 * ## The rule
 *
 * `hasAppsStoreAccess(features) && (isAppDeveloper(user, …) || appBlocksGetStarted)`
 *
 * - The STORE term is a hard precondition. `/apps/build` is a surface INSIDE the apps
 *   store IA — it renders under the same `AppsSubNav` chrome, its workbench state links
 *   into `/apps/listing/<id>/edit`, and its Marketplace sibling tab is store-gated. A
 *   viewer with no store access has no `/apps` at all, so admitting them here would put
 *   them on a page whose every onward link 404s.
 * - The AUTHOR term is what opens states B/C (first-app + workbench). It routes through
 *   {@link isAppDeveloper}, so moderators stay a hard floor.
 * - The `appBlocksGetStarted` term keeps its KILL-SWITCH meaning exactly: it governs
 *   whether a store-visible NON-author is shown the recruiting pitch (state A). Flip
 *   `app-blocks-get-started` off in Flipt and the pitch — and the tab offering it —
 *   disappear for non-authors, with no deploy. It cannot switch an AUTHOR out of their
 *   own workbench, which is correct: the kill switch is on the funnel, not on authoring.
 *
 * 🔴 HYDRATION-SAFE, AND MEASURED RATHER THAN ASSUMED. All of the inputs are SSR-seeded
 * and FROZEN, so this predicate computes the same boolean on the server render and on
 * the first client paint, and its callers must NOT defer it behind `useIsClient()`:
 *   • `appBlocksAuthor` and `appBlocksGetStarted` are resolved server-side in `_app`'s
 *     `getInitialProps`, serialized into `pageProps.flags`, and frozen by
 *     `useState(initialFlags)` in `FeatureFlagsProvider`. NEITHER declares
 *     `toggleable: true` in `feature-flags.service.ts` (verified at this ref:
 *     `appBlocksGetStarted` and `appBlocksAuthor` are bare
 *     `{ availability: ['mod'], fliptKey: … }` entries), so
 *     `computeUserFeatureFlagsOverlay` never emits them and the client
 *     `user.getFeatureFlags` overlay cannot move them.
 *   • the three store flags are frozen the same way, via {@link hasAppsStoreAccess}.
 *   • `user.isModerator` rides `SessionProvider`'s `useState(initial)`, seeded from the
 *     same SSR `pageProps.session`; when that seed is `undefined` the SERVER also
 *     rendered without a user, so the first client paint still matches.
 * What is NOT frozen — and therefore IS deferred by its consumer — is
 * `blocks.getNavSummary`, which decides state B vs state C. See `AppsBuildBody`.
 *
 * Fails CLOSED: absent / null features, or an empty object, → `false`.
 *
 * Pure (no server/client-only imports) so it is usable from both the
 * `getServerSideProps` resolver and the client-side nav container.
 */
export function canAccessAppsBuild(
  user: { isModerator?: boolean | null } | null | undefined,
  features: AppsBuildFeatureFlags
): boolean {
  if (!hasAppsStoreAccess(features)) return false;
  return (
    isAppDeveloper(user, { appBlocksAuthor: features?.appBlocksAuthor }) ||
    !!features?.appBlocksGetStarted
  );
}

/**
 * The store-visibility flag pair, in the shape every caller already has in hand
 * (`ctx.features` on the SSR side, `useFeatureFlags()` on the client). Optional
 * + nullable so a Flipt-down / not-yet-created flag and an absent `features`
 * object both flow in without a cast.
 *
 * 🔴 DERIVED FROM `FeatureAccess`, NOT hand-written — this is load-bearing, and a
 * hand-written `{ appBlocks?: boolean; appListings?: boolean }` was measurably
 * worse. Under the structural version, dropping or renaming `appListings` in
 * `feature-flags.service.ts` would make the OLD open-coded `features.appListings`
 * reads fail with `TS2339`, but `hasAppsStoreAccess(features)` would keep
 * compiling — silently degrading every store surface to `appBlocks`-only. That
 * rename is not hypothetical: it is exactly the documented "drop the OR-fallback
 * once `app-listings` is the sole source of truth" step at GA. Keying off
 * `FeatureAccess` turns that silent degradation into a compile error here.
 *
 * The import is TYPE-ONLY, so nothing from the server module reaches a runtime
 * bundle (the established pattern — see `src/shared/data-graph/generation/context.ts`).
 */
export type AppsStoreFeatureFlags =
  | Partial<Pick<FeatureAccess, 'appBlocks' | 'appListings' | 'appListingsPublicExternal'>>
  | null
  | undefined;

/**
 * App Blocks — App STORE-VISIBILITY gate
 * (`appListings || appBlocks || appListingsPublicExternal`).
 *
 * 🔒 THE SINGLE SOURCE OF TRUTH for "may this viewer see the /apps store", for
 * eight surfaces: the `/apps` SSR resolver (`resolveAppsPageAccess`), the `/apps`
 * page body, the store-preview route, the marketplace grid query, the
 * related-listings rail, the `/apps/*` sub-nav — all six under `components/Apps`
 * / `pages/apps` — the user-menu "Apps" → `/apps` entry
 * (`components/AppLayout/AppHeader/appsNavVisibility.ts`, since #3907), and the
 * top-nav pill (`components/HomeContentToggle/nav-registry.ts`). All eight route
 * through THIS predicate.
 *
 * ⚠️ "Every store surface" would still be TOO STRONG, so it is not claimed —
 * only that these eight are pinned. The seventh was converted because it was, until the
 * top-nav pill shipped, the only in-product route to `/apps` — while it read
 * `appBlocks` alone a
 * `{appListings, NOT appBlocks}` or external-only cohort got a store that
 * rendered but could not be found. Converting it widens DISCOVERY only: the
 * block-runtime surfaces listed below keep their own gates.
 *
 * Do NOT re-inline `features.appListings || features.appBlocks`; the
 * gates drifting apart is exactly what this function exists to prevent, and it
 * had already happened once: of the SIX store-visibility sites, five spelled the
 * OR out and the sixth — `AppsSubNav` — spelled only half of it (`appBlocks`
 * alone), so an `app-listings`-only cohort would have loaded `/apps` with no
 * sub-navigation at all.
 *
 * ENFORCED, not merely requested: `components/Apps/__tests__/appsStoreAccessCallSites.test.ts`
 * pins the exact ledger of the eight sites and fails if one is added, reverted, or
 * re-inlines the boolean. Adding a store surface means adding it to that ledger.
 *
 * ## Why an OR, and which flag is which
 *
 * `appListings` (Flipt `app-listings`) is the DEDICATED catalog-visibility flag;
 * `appBlocks` (Flipt `app-blocks-enabled`) doubles as the block-RUNTIME
 * kill-switch. W13 split them so the store catalog can widen to public
 * INDEPENDENTLY of the deliberately-held block-runtime GA — a public launch
 * widens ONLY `app-listings`. The OR-fallback to `appBlocks` keeps the CURRENT
 * mods + `app-dev-testers` cohort's store access verbatim through the transition
 * window (both flags resolve true for them today, so this is zero behaviour
 * change). Drop the fallback only once `app-listings` is the sole, wider source
 * of truth. Server-side mirror: `isAppListingsEnabled` in
 * `~/server/services/app-blocks-flag`.
 *
 * `appListingsPublicExternal` (Flipt `app-listings-public-external`) is the THIRD,
 * ORTHOGONAL term: the EXTERNAL-ONLY cohort. Its holders are not "less privileged
 * catalog viewers" — they are viewers the SERVER will serve a `kind='offsite'`-only
 * catalog to (`resolveStoreVisibilityScope` → `public-external`). They must be
 * admitted HERE or `/apps` is structurally unreachable for them: this predicate is
 * the only thing standing between them and `notFound`, so the server would resolve
 * a perfectly good external catalog for a page they can never load.
 *
 * 🔴 REACHABILITY ONLY — this term does NOT decide WHAT they see. That is the
 * server's `StoreVisibilityScope`, threaded into the data-layer kind predicate. A
 * viewer admitted solely by this flag reaches the store and sees offsite listings
 * and nothing else; onsite App Blocks stay hidden by the SERVER, not by this gate.
 * So do NOT read this OR as "external-flag holders get the full catalog."
 *
 * 🔴 SEAM: `appListingsPublicExternal` and the server's
 * `isExternalListingsPublicEnabled()` are two evaluations of ONE Flipt key and must
 * agree, or a viewer passes this gate and gets an empty store (or is 404'd off a
 * catalog the server would serve). They agree by construction for a logged-in
 * viewer (same key, same entityId, same `buildFliptContext`) and fail closed
 * together when the flag is absent — the client entry is deliberately
 * `availability: []` so its Flipt-down static answer is `false` too. Full
 * reasoning + the anon residual: `isExternalListingsPublicEnabled` in
 * `~/server/services/app-blocks-flag`. Pinned by
 * `components/Apps/__tests__/hasAppsStoreAccess.test.ts` and — with BOTH real sides
 * driven against one fake Flipt config —
 * `server/services/__tests__/app-blocks-flag.external-scope.seam.test.ts`.
 *
 * 🔴 This is NOT the gate for the block-RUNTIME surfaces. `/apps/activity`,
 * `/apps/review`, `/apps/my-submissions`, `/apps/revenue`, `/apps/run/<slug>`
 * and the `blocks.*` tRPC procedures gate on the RUNTIME flags, on purpose —
 * they need the runtime, not just the catalog. (`/apps/activity` is the one that
 * takes `appBlocks || appBlocksPages` rather than `appBlocks` alone; see
 * {@link canAccessAppsActivity} for why the page flag is a second disjunct there
 * and nowhere else.) Widening them is a product
 * decision, not a mechanical alignment; do not sweep them into this predicate.
 * The external-only cohort in particular must NOT reach them: they hold neither
 * `appBlocks` nor `appListings`, and adding this third term here leaves those
 * surfaces untouched.
 *
 * Fails CLOSED: absent / null features, or an empty object, → `false`.
 */
export function hasAppsStoreAccess(features: AppsStoreFeatureFlags): boolean {
  return !!features?.appListings || !!features?.appBlocks || !!features?.appListingsPublicExternal;
}

/**
 * The flag shape {@link canAccessAppsActivity} needs — the two App-Blocks RUNTIME
 * flags. Derived from `FeatureAccess` (type-only import) so a rename at GA breaks
 * here at compile time rather than silently degrading the gate to one term.
 */
export type AppsActivityFeatureFlags =
  | Partial<Pick<FeatureAccess, 'appBlocks' | 'appBlocksPages'>>
  | null
  | undefined;

/**
 * App Blocks — the `/apps/activity` (per-viewer app ACTIVITY) surface gate:
 * `appBlocks || appBlocksPages`.
 *
 * 🔒 THE SINGLE SOURCE OF TRUTH for "may this viewer reach /apps/activity", consumed
 * by the page's SSR resolver (`~/components/Apps/resolveActivityPageAccess`) and
 * by the page body's client-side re-check. Two callers, one function — the
 * shared-predicate pattern {@link canAccessAppsBuild} exists for, and for the same
 * recorded reason: a tab or a body gate written separately from its page's SSR gate
 * WILL drift (#3899, PR #4668).
 *
 * 🔴 THE SECOND DISJUNCT IS THE WHOLE POINT OF THE `/apps/installed` → `/apps/activity`
 * RENAME. The page used to gate on `appBlocks` alone, which is the SLOT flag — it
 * governs the `BlockSlot` mount on model pages. Someone who has only ever run a
 * FULL-PAGE app (`/apps/run/<slug>`, gated on `appBlocksPages`) has app activity —
 * generations, scope-gated API calls, Buzz spends — and no slot install at all.
 * Calling the page "Activity" while refusing them is the dishonest half of the rename.
 *
 * 🔴 IT IS NOT `hasAppsStoreAccess`. That predicate governs the CATALOG (`/apps`,
 * the listing detail) and carries `appListingsPublicExternal`, the external-only
 * cohort that holds neither runtime flag. This page reads `blocks.*` procedures, all
 * of which gate on the runtime — so widening it to the store predicate would admit a
 * cohort to a page whose every query answers all-false.
 *
 * ⚠️ SCOPE: this gates the PAGE. The `Installs` TAB inside it stays on
 * `features.appBlocks` alone, because that tab's content (slot subscriptions /
 * per-model installs) is what the slot flag governs — a tab's predicate is its
 * content's own gate, restated. See `pages/apps/activity.tsx`.
 *
 * Neither flag is `toggleable: true` in `feature-flags.service.ts`, so
 * `computeUserFeatureFlagsOverlay` never emits them and the client value cannot move
 * between the SSR gate and the first client paint — which is what lets one predicate
 * serve both without a hydration hazard.
 *
 * Fails CLOSED: absent / null features, or an empty object, → `false`.
 */
export function canAccessAppsActivity(features: AppsActivityFeatureFlags): boolean {
  return !!features?.appBlocks || !!features?.appBlocksPages;
}

/**
 * The viewer's {@link StoreVisibilityScope}, derived CLIENT-SIDE from the resolved
 * feature flags — the mirror of the server's `resolveStoreVisibilityScope`.
 *
 * 🔴 PRIORITY ORDER IS THE "NEVER NARROW A MODERATOR" INVARIANT, copied deliberately
 * from the server resolver and not re-reasoned: axis 1 (`appListings || appBlocks`,
 * the `isAppListingsEnabled` OR-fallback in client form) short-circuits to `full`, so
 * a moderator who is ALSO in the external cohort is never narrowed to offsite-only.
 * Swap the two and a mod loses the onsite half of the store.
 *
 * 🔴 THIS DECIDES AN AFFORDANCE, NEVER AN ENTITLEMENT. The server's scope is the real
 * one; this exists so the UI does not offer a control the server will refuse. It is
 * the same server/client SEAM `hasAppsStoreAccess` documents — same three Flipt keys,
 * same `buildFliptContext` on both sides for a logged-in viewer — and it fails closed
 * the same way (absent flags → `none`).
 *
 * Why derive a SCOPE rather than read a flag: reviewability is a question about a
 * listing's KIND, and a flag name cannot answer it. Pairing this with
 * {@link scopeAdmitsListingKind} is what keeps the button's visibility and the write
 * gate's answer in agreement.
 */
export function resolveClientStoreScope(features: AppsStoreFeatureFlags): StoreVisibilityScope {
  if (features?.appListings || features?.appBlocks) return 'full';
  if (features?.appListingsPublicExternal) return 'public-external';
  return 'none';
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
