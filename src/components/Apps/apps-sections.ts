import type { Icon } from '@tabler/icons-react';
import {
  IconBuildingStore,
  IconCode,
  IconCurrencyDollar,
  IconGavel,
  IconMail,
  IconPlugConnected,
} from '@tabler/icons-react';

/**
 * `/apps/*` SECOND-LEVEL NAVIGATION — the declarative section registry behind the
 * left rail.
 *
 * 🔴 THIS FILE IS THE PORT OF `SUB_NAV_LINKS`, WHICH LIVED IN `AppsSubNav.tsx` AND
 * DROVE A HORIZONTAL TAB STRIP. The strip is gone: `/apps/*` rendered TWO stacked
 * horizontal nav bars (the global `SubNav2` pill strip from
 * `~/components/AppLayout/SubNav`, which carries an "Apps" pill, and then this one),
 * and the second of them is now a vertical rail in `AppsPageLayout`. The DATA did not
 * change — see the predicate note below, which is the one property this table has to
 * keep across the move.
 *
 * Shaped after `~/components/Account/account-sections`, which is the in-repo precedent
 * for a section registry behind a rail, with ONE deliberate omission: there are no
 * `keywords` and no `searchAccountSections` equivalent. That search box exists because
 * eight account sections hide hundreds of individual settings, so a label-only match
 * finds nothing you did not already know the name of. `/apps` has at most SIX
 * destinations, all of which fit on screen at once; a search box over six visible links
 * is chrome that answers a question nobody has.
 */

/**
 * The conditions that drive which sections are visible. Sourced from the
 * single lightweight `blocks.getNavSummary` query (booleans only — no rows) so
 * the nav doesn't fan out to the heavyweight per-page queries
 * (`listMySubscriptions` / `listMyPublishRequests` / `getMyApps`) just to pick
 * which sections to show.
 */
export type AppsNavSummary = {
  /** ≥1 install/subscription (a `block_user_subscriptions` row) — half of "Activity". */
  hasInstalls: boolean;
  /**
   * ≥1 row in EITHER table the activity feed walks — `block_buzz_attribution` (as the
   * SPENDER) or `block_scope_invocations` — the OTHER half of "Activity".
   *
   * 🔴 IT IS NOT REDUNDANT WITH {@link hasInstalls}, AND THE GAP IS A WHOLE COHORT. An
   * install is a SLOT subscription; a FULL-PAGE app (`/apps/run/<slug>`) is stateless by
   * design and creates no subscription row at all. So a viewer who only ever runs page
   * apps has activity — generations, scope-gated API calls, Buzz spends — and
   * `hasInstalls: false`. Neither flag implies the other: an install with no usage yet is
   * the mirror case.
   */
  hasActivity: boolean;
  /**
   * ≥1 publish request. Drove a "My submissions" section, then widened "My apps".
   *
   * ⚠️ NO LONGER READ BY THIS TABLE. Both of those sections are gone — `/apps/build`
   * absorbed them — and the row that replaced them keys off `canAccessAppsBuild`, which
   * consults no summary flag (deliberately: this data is client-only, and a nav entry
   * that appears after mount is the hydration mismatch this surface already survived
   * once). It is still fetched and still load-bearing: `resolveAppsBuildState` reads it
   * to choose the workbench over the first-app state, which is the ONLY surface an
   * orphaned submission has.
   */
  hasSubmissions: boolean;
  /** ≥1 owned app in the `approved` state → show "Revenue". */
  hasApprovedApps: boolean;
  /** app reviewer (mod) → show "Review". */
  isReviewer: boolean;
  /**
   * ≥1 listing owned OR held via an ACCEPTED collaborator seat.
   *
   * ⚠️ Same as `hasSubmissions`: no longer read by this table, still read by
   * `resolveAppsBuildState`.
   *
   * 🔴 The seat half is why this cannot be folded into `hasSubmissions`: a collaborator
   * has submitted nothing, so every other flag on this summary is `false` for them and
   * there would be no route to an app they can genuinely edit.
   */
  hasEditableApps: boolean;
  /** ≥1 PENDING invitation → show "Invites". True for someone who owns nothing. */
  hasPendingInvites: boolean;
};

/** No summary — the shape a viewer with no rows at all resolves to. */
export const EMPTY_APPS_NAV_SUMMARY: AppsNavSummary = {
  hasInstalls: false,
  hasActivity: false,
  hasSubmissions: false,
  hasApprovedApps: false,
  isReviewer: false,
  hasEditableApps: false,
  hasPendingInvites: false,
};

/**
 * The viewer CAPABILITIES that drive section visibility, as opposed to the
 * `getNavSummary` booleans above. Kept a SEPARATE object (rather than folded
 * into {@link AppsNavSummary}) because the two have different provenance and
 * different hydration behaviour, and that difference is load-bearing:
 *
 *  - `AppsNavSummary` comes from the client-only `blocks.getNavSummary` query,
 *    so it is ABSENT during SSR + the first client paint (see the `useIsClient`
 *    note on the container) and its sections reveal only after mount.
 *  - `AppsNavContext` is resolved from values that are SSR-seeded and identical
 *    on the first client render, so it can be applied to the very first paint
 *    without a hydration mismatch. See `useAppsNavSections` for the derivation.
 */
export type AppsNavContext = {
  /**
   * May AUTHOR apps (`dev:live`, the invite inbox). Resolved via the shared
   * `isAppDeveloper` predicate — moderators are a hard floor, the
   * `appBlocksAuthor` capability widens it to the curated non-mod cohort.
   *
   * ⚠️ NO LONGER THE GATE ON AN AUTHORING SECTION. "Create" and "My apps" were
   * consolidated into "Build", which keys off {@link canBuild}. This survives for
   * "Invites", whose page gates on `appBlocksAuthor` + `isAppDeveloper` alone.
   */
  isAuthor: boolean;
  /**
   * May load `/apps/build` → show "Build". This is the page's OWN gate turned into a
   * viewer fact, and it is computed by the SHARED `canAccessAppsBuild` — the
   * same call `resolveBuildPageAccess` makes in `getServerSideProps`. Not re-derived
   * here; see that predicate for why one function rather than two spellings.
   */
  canBuild: boolean;
  /**
   * May load `/apps` → show "Marketplace". `hasAppsStoreAccess`, i.e. the SAME rule
   * `resolveAppsPageAccess` enforces for that page.
   *
   * 🔴 THIS ENTRY USED TO BE UNCONDITIONAL (`visible: () => true`), AND THAT WAS A LIVE
   * 404 WAITING ON A FLIPT TOGGLE — documented as a known exposure on both
   * `pages/apps/get-started.tsx` and the old "Build apps" entry below, and left open
   * because gating it would have dropped the get-started-only cohort to one entry, where
   * the `< 2` collapse deletes the whole nav. That argument no longer holds: "Build" is
   * now itself store-gated (`canAccessAppsBuild` requires store access), so that cohort
   * has no `/apps/*` destination to be dropped to and there is nothing left to protect
   * by leaving an entry pointing at a page that answers `notFound`.
   */
  canSeeStore: boolean;
};

/** No capabilities — the shape a viewer with no flags at all resolves to. */
export const NO_APPS_NAV_CAPABILITIES: AppsNavContext = {
  isAuthor: false,
  canBuild: false,
  canSeeStore: false,
};

/**
 * The rail's GROUP HEADINGS, in render order.
 *
 * 🔴 THE GROUPS ARE THE ORIGINAL TAB ORDER, GIVEN NAMES — not a new information
 * architecture. `SUB_NAV_LINKS` carried its ordering rule in prose ("discovery → manage
 * → revenue → build → moderate"); a vertical rail has room to say it out loud, so each
 * phase of that comment became a heading. `Yours` covers "manage" AND "revenue", which
 * are both the viewer's own holdings; nothing else merged and nothing reordered.
 */
export const appsSectionGroups = [
  { id: 'discover', label: 'Discover' },
  { id: 'yours', label: 'Yours' },
  { id: 'build', label: 'Build' },
  { id: 'moderate', label: 'Moderate' },
] as const;

export type AppsSectionGroupId = (typeof appsSectionGroups)[number]['id'];

export type AppsSection = {
  id: string;
  /** URL segment under `/apps`. Empty string is the marketplace index. */
  path: string;
  label: string;
  icon: Icon;
  group: AppsSectionGroupId;
  /** Whether this section renders for the given summary + viewer capabilities. */
  visible: (s: AppsNavSummary, c: AppsNavContext) => boolean;
};

/**
 * Section order = discovery → manage → revenue → build → moderate.
 *
 * 🔴 `Build` SITS SECOND-TO-LAST (before `Review`), and the order is the claim. This
 * nav's leading entry is the one it asserts you came here for, and for the
 * overwhelming majority of viewers that is not authoring: `Build` is gated on
 * `canAccessAppsBuild`, while `Marketplace` and `Activity` are the two consumer
 * surfaces. Leading with `Build` put the narrowest audience's destination in the widest
 * audience's first position. `Review` stays last because it is the moderator surface
 * and reads as the end of the table rather than part of the user's own path.
 *
 * 🔴 EVERY ROW'S PREDICATE IS ITS PAGE'S OWN GATE, RESTATED AS A VIEWER FACT ON
 * {@link AppsNavContext} — never a raw flag read inside the predicate, and never a rule
 * invented here. That is the ONE property this table has to keep. Both defects this
 * table has shipped were the same shape: an entry whose visibility rule was written
 * separately from the gate on the page it points at, and the two drifted. #3899 was
 * "Create" (store-gated entry → author-gated page); PR #4668 found it again on an entry
 * shown to a cohort its page refused; a clean `git` auto-merge once left two rows on
 * the OLD one-argument signature with every test green.
 *
 * 🔴 SO THE PREDICATES BELOW WERE CARRIED ACROSS FROM `SUB_NAV_LINKS` VERBATIM WHEN THE
 * TAB STRIP BECAME THIS RAIL — not re-derived, not simplified, not "cleaned up". A
 * layout change is exactly the occasion on which a predicate gets rewritten for tidiness
 * and quietly widens, which is the #3899/#4668 class arriving a third time.
 * `__tests__/appsSectionsPredicates.test.ts` pins each one against the full cohort
 * matrix and fails if any is edited.
 *
 * "Build" is the strongest form of the fix available: its predicate is not restated
 * here at all, it is the SHARED `canAccessAppsBuild`, which the page's
 * `getServerSideProps` calls too. One function, two callers, no spelling to drift.
 *
 * ⚠️ KNOWN, PRE-EXISTING, DELIBERATELY NOT FIXED HERE — issue #3906: `/apps/submit`'s
 * CLIENT BODY carries an extra `if (!features?.appBlocks) return <NotFound />` its own
 * SSR gate does not. `/apps/submit` has no row in this table (its authoring entry point
 * is "Build"), so this nav is not a route into it at all; the remaining ways in are the
 * create buttons on `/apps/build` and the `?edit=` deep link from the store card. The
 * outlier is still submit.tsx's body.
 *
 * The rail still hides itself entirely below two sections — a one-entry "navigation" is
 * chrome that navigates nowhere. 🔴 That floor IS reachable, by a live cohort: a
 * store-visible non-author with no installs and no `appBlocksGetStarted` qualifies for
 * Marketplace ALONE and gets no rail. Unchanged by the rail move — that viewer had
 * exactly the same one tab before it.
 */
export const appsSections: AppsSection[] = [
  /**
   * 🔴 GATED ON STORE ACCESS — it was `() => true`, and that unconditional predicate was
   * a KNOWN, DOCUMENTED 404 exposure (see the note on `AppsNavContext.canSeeStore`):
   * `/apps` gates on `resolveAppsPageAccess`, so a viewer admitted to this nav by the
   * get-started term alone was offered an entry the page answers `notFound` for. It was
   * left open because closing it used to drop that viewer to ONE entry, where the `< 2`
   * collapse hides the nav entirely — deleting the only entry that cohort had. "Build"
   * being store-gated removes that objection: such a viewer now has no `/apps/*`
   * destination at all, so there is nothing to preserve by pointing them at a 404.
   */
  {
    id: 'marketplace',
    path: '',
    label: 'Marketplace',
    icon: IconBuildingStore,
    group: 'discover',
    visible: (_s, c) => c.canSeeStore,
  },
  /**
   * 🔴 BOTH TERMS ARE LOAD-BEARING; NEITHER IS A RESTATEMENT OF THE OTHER, AND
   * "SIMPLIFYING" THIS TO `s.hasInstalls` RE-HIDES THE PAGE FROM THE COHORT THE
   * `/apps/installed` → `/apps/activity` RENAME WIDENED IT FOR. They name two different
   * facts:
   *   • `hasInstalls` — a `block_user_subscriptions` row, i.e. a SLOT install. That is
   *     what the "Installs" tab inside the page shows, and it is what the `appBlocks`
   *     slot flag governs.
   *   • `hasActivity` — a row in either table the FEED walks (`block_buzz_attribution` as
   *     spender, `block_scope_invocations`). A full-page app is STATELESS by design —
   *     `/apps/run`'s own header, Decision 2: "no `block_user_subscriptions` row, no
   *     migration" — so someone who only runs page apps has a populated feed and ZERO
   *     installs. Keyed on installs alone, this row was dark for exactly them: the page
   *     admitted them (`appBlocks || appBlocksPages`) and nothing pointed at it.
   * An install with no usage yet is the mirror case, which is why the OR keeps both.
   *
   * ⚠️ A RESIDUAL NARROWNESS SURVIVES, deliberately, and it is the SAFE direction of the
   * #3899 / #4668 class (an unreachable page, never an entry into a 404): both flags come
   * from `getNavSummary`, whose `enabled` and whose server middleware are gated on
   * `appBlocks`, while the page admits `appBlocks || appBlocksPages`. A viewer holding
   * `appBlocksPages` WITHOUT `appBlocks` still gets an all-false summary and no entry.
   * Closing that means moving the procedure's own gate, which is a wider blast radius
   * than this row (every flag on the summary would widen with it).
   *
   * ⚠️ …AND THAT RESIDUAL IS NARROWER THAN THE SENTENCE ABOVE IMPLIES — corrected after an
   * audit, because as written it invites a future widening of a `blocks.*` flag gate to
   * close a gap that is effectively EMPTY. That cohort is refused by `/apps/run` itself
   * (`[[...path]].tsx` requires BOTH `appBlocks` and `appBlocksPages`) and cannot install
   * (slot installs are `appBlocks`-gated), so going forward they can generate NO activity
   * at all: an all-false summary is the CORRECT section set for them, not a deprivation.
   * The only way they hold rows is a historical `appBlocks` grant since revoked. Do not
   * widen the procedure's gate for this.
   */
  {
    id: 'activity',
    path: 'activity',
    label: 'Activity',
    icon: IconPlugConnected,
    group: 'yours',
    visible: (s) => s.hasInstalls || s.hasActivity,
  },
  /**
   * 🔴 NEEDS `c.isAuthor` AS WELL AS ITS SUMMARY FLAG. `/apps/invites`
   * `getServerSideProps`-gates on `features.appBlocksAuthor` + `isAppDeveloper` and
   * otherwise returns `notFound`, while the summary driving it does NOT:
   * `blocks.getNavSummary` is gated on the marketplace `appBlocks` flag, not the author
   * one. And it is reachable — `inviteCollaborator` accepts ANY existing, non-banned user
   * id as the target, nothing requires the invitee to be an author, so
   * `hasPendingInvites` goes true for a non-author whenever an owner invites them.
   *
   * (The `Revenue` entry below deliberately does NOT do this — see its own comment. That
   * is a recorded decision about an OWNERSHIP affordance, not an oversight.)
   */
  {
    id: 'invites',
    path: 'invites',
    label: 'Invites',
    icon: IconMail,
    group: 'yours',
    visible: (s, c) => c.isAuthor && s.hasPendingInvites,
  },
  {
    id: 'revenue',
    path: 'revenue',
    // INTENTIONAL mismatch: this entry is keyed on app OWNERSHIP (hasApprovedApps),
    // but `/apps/revenue` itself gates on `isAppDeveloper` (mod). An owner who
    // isn't a mod sees the entry but the page enforces access — don't "fix" this
    // by aligning them; the entry is an ownership affordance, the page is the
    // access boundary. (Pre-GA, ownership ⊆ mod, so both resolve the same.)
    label: 'Revenue',
    icon: IconCurrencyDollar,
    group: 'yours',
    visible: (s) => s.hasApprovedApps,
  },
  /**
   * The consolidated BUILD surface — the ONLY authoring entry in this nav.
   *
   * 🔴 THIS ROW REPLACED THREE: "Build apps" (`/apps/get-started`), "Create"
   * (`/apps/submit`) and "My apps" (`/apps/mine`). Those three were largely one another's
   * content — get-started was static marketing whose every CTA pointed off-platform, and
   * `/apps/submit`'s on-platform branch was the same copy-paste wall a second time — so a
   * developer's path was three destinations that mostly showed each other. `/apps/build`
   * is state-aware instead: pitch → first-app → workbench. The two retired routes 301 to
   * it; `/apps/submit` KEEPS its route (the `?edit=<listingId>` deep link from the store
   * card and the listing-detail ⋮ menus resolves there via `getOwnerEditHref`) and simply
   * stops having a nav entry.
   *
   * 🔴 NOT `c.isAuthor`, AND NOT `!!features.appBlocksGetStarted` — `c.canBuild`, which
   * is `canAccessAppsBuild` verbatim. `hasSubmissions` / `hasEditableApps` are
   * deliberately ABSENT from this predicate even though they decide what the page
   * RENDERS: they come from the client-only `getNavSummary`, and an entry that appeared
   * after mount for an author with apps is the hydration mismatch this surface already
   * survived once. The page's own state machine reads them; the nav does not.
   *
   * Hydration-safe for the reason written out on the predicate: all of its inputs are
   * SSR-seeded and frozen, and neither `appBlocksAuthor` nor `appBlocksGetStarted` is
   * `toggleable`, so `computeUserFeatureFlagsOverlay` cannot move them between the
   * server render and the first client paint.
   */
  {
    id: 'build',
    path: 'build',
    label: 'Build',
    icon: IconCode,
    group: 'build',
    visible: (_s, c) => c.canBuild,
  },
  {
    id: 'review',
    path: 'review',
    label: 'Review',
    icon: IconGavel,
    group: 'moderate',
    visible: (s) => s.isReviewer,
  },
];

/** The href a section links to. `/apps` for the index, `/apps/<path>` otherwise. */
export function getAppsSectionHref(section: AppsSection): string {
  return section.path ? `/apps/${section.path}` : '/apps';
}

/**
 * Returns true when `current` is on the `href` route. `/apps` (the
 * marketplace) must match EXACTLY so it isn't lit on every `/apps/*` child;
 * the sub-routes match on prefix so deep paths (e.g. `/apps/activity/<x>`
 * or `/apps/run/<slug>` under the parent) keep the right section active.
 */
export function isActiveAppsRoute(href: string, current: string): boolean {
  if (href === '/apps') return current === '/apps';
  return current === href || current.startsWith(`${href}/`);
}

/**
 * The section that should be active for `currentPath`, or `null` when none matches
 * (a deep `/apps/*` route with no corresponding section leaves the rail with nothing
 * highlighted rather than mis-lighting one).
 */
export function activeAppsSection(currentPath: string): AppsSection | null {
  return appsSections.find((s) => isActiveAppsRoute(getAppsSectionHref(s), currentPath)) ?? null;
}

/** The sections a given viewer sees, in registry order. */
export function visibleAppsSections(
  summary: AppsNavSummary,
  context: AppsNavContext
): AppsSection[] {
  return appsSections.filter((s) => s.visible(summary, context));
}

/**
 * The floor below which the rail renders NOTHING.
 *
 * A single-entry "navigation" can only link to the page you are already on, and it
 * still costs 276px of horizontal chrome on every `/apps/*` surface. Two is the floor at
 * which it is a navigation affordance rather than a decoration. Carried over unchanged
 * from the tab strip, where the same floor deleted the bar.
 */
export const APPS_NAV_MIN_SECTIONS = 2;
