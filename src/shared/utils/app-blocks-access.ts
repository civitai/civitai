import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

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
 * seven surfaces: the `/apps` SSR resolver (`resolveAppsPageAccess`), the `/apps`
 * page body, the store-preview route, the marketplace grid query, the
 * related-listings rail, the `/apps/*` sub-nav — all six under `components/Apps`
 * / `pages/apps` — and, since #3907, the user-menu "Apps" → `/apps` entry
 * (`components/AppLayout/AppHeader/appsNavVisibility.ts`). All seven route
 * through THIS predicate.
 *
 * ⚠️ "Every store surface" would still be TOO STRONG, so it is not claimed —
 * only that these seven are pinned. The seventh was converted because it is the
 * ONLY in-product route to `/apps`, so while it read `appBlocks` alone a
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
 * pins the exact ledger of the seven sites and fails if one is added, reverted, or
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
 * 🔴 This is NOT the gate for the block-RUNTIME surfaces. `/apps/installed`,
 * `/apps/review`, `/apps/my-submissions`, `/apps/revenue`, `/apps/run/<slug>`
 * and the `blocks.*` tRPC procedures gate on `appBlocks` alone, on purpose —
 * they need the runtime, not just the catalog. Widening them is a product
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
