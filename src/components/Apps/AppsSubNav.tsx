import { Box, rem, ScrollArea, Tabs } from '@mantine/core';
import {
  IconBuildingStore,
  IconCode,
  IconCurrencyDollar,
  IconGavel,
  IconMail,
  IconPlugConnected,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useIsClient } from '~/providers/IsClientProvider';
import {
  canAccessAppsBuild,
  hasAppsStoreAccess,
  isAppDeveloper,
} from '~/shared/utils/app-blocks-access';

/**
 * The conditions that drive which sub-nav tabs are visible. Sourced from the
 * single lightweight `blocks.getNavSummary` query (booleans only — no rows) so
 * the sub-nav doesn't fan out to the heavyweight per-page queries
 * (`listMySubscriptions` / `listMyPublishRequests` / `getMyApps`) just to pick
 * which tabs to show.
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
   * ≥1 publish request. Drove a "My submissions" tab, then widened "My apps".
   *
   * ⚠️ NO LONGER READ BY THIS TABLE. Both of those tabs are gone — `/apps/build`
   * absorbed them — and the row that replaced them keys off `canAccessAppsBuild`, which
   * consults no summary flag (deliberately: this data is client-only, and a tab that
   * appears after mount is the hydration mismatch this file already survived once). It
   * is still fetched and still load-bearing: `resolveAppsBuildState` reads it to choose
   * the workbench over the first-app state, which is the ONLY surface an orphaned
   * submission has.
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

const EMPTY_SUMMARY: AppsNavSummary = {
  hasInstalls: false,
  hasActivity: false,
  hasSubmissions: false,
  hasApprovedApps: false,
  isReviewer: false,
  hasEditableApps: false,
  hasPendingInvites: false,
};

/**
 * The viewer CAPABILITIES that drive tab visibility, as opposed to the
 * `getNavSummary` booleans above. Kept a SEPARATE object (rather than folded
 * into {@link AppsNavSummary}) because the two have different provenance and
 * different hydration behaviour, and that difference is load-bearing:
 *
 *  - `AppsNavSummary` comes from the client-only `blocks.getNavSummary` query,
 *    so it is ABSENT during SSR + the first client paint (see the `useIsClient`
 *    note on the container) and its tabs reveal only after mount.
 *  - `AppsNavContext` is resolved from values that are SSR-seeded and identical
 *    on the first client render, so it can be applied to the very first paint
 *    without a hydration mismatch. See the container for the derivation.
 */
export type AppsNavContext = {
  /**
   * May AUTHOR apps (`dev:live`, the invite inbox). Resolved via the shared
   * {@link isAppDeveloper} predicate — moderators are a hard floor, the
   * `appBlocksAuthor` capability widens it to the curated non-mod cohort.
   *
   * ⚠️ NO LONGER THE GATE ON AN AUTHORING TAB. "Create" and "My apps" were
   * consolidated into "Build", which keys off {@link canBuild}. This survives for
   * "Invites", whose page gates on `appBlocksAuthor` + `isAppDeveloper` alone.
   */
  isAuthor: boolean;
  /**
   * May load `/apps/build` → show "Build". This is the page's OWN gate turned into a
   * viewer fact, and it is computed by the SHARED {@link canAccessAppsBuild} — the
   * same call `resolveBuildPageAccess` makes in `getServerSideProps`. Not re-derived
   * here; see that predicate for why one function rather than two spellings.
   */
  canBuild: boolean;
  /**
   * May load `/apps` → show "Marketplace". `hasAppsStoreAccess`, i.e. the SAME rule
   * `resolveAppsPageAccess` enforces for that page.
   *
   * 🔴 THIS TAB USED TO BE UNCONDITIONAL (`visible: () => true`), AND THAT WAS A LIVE
   * 404 WAITING ON A FLIPT TOGGLE — documented as a known exposure on both
   * `pages/apps/get-started.tsx` and the old "Build apps" entry below, and left open
   * because gating it would have dropped the get-started-only cohort to one tab, where
   * the `< 2` collapse deletes the whole bar. That argument no longer holds: "Build" is
   * now itself store-gated (`canAccessAppsBuild` requires store access), so that cohort
   * has no `/apps/*` destination to be dropped to and there is nothing left to protect
   * by leaving a tab pointing at a page that answers `notFound`.
   */
  canSeeStore: boolean;
};

/** No capabilities — the shape a viewer with no flags at all resolves to. */
const NO_CAPABILITIES: AppsNavContext = { isAuthor: false, canBuild: false, canSeeStore: false };

type SubNavLink = {
  href: string;
  label: string;
  icon: typeof IconPlugConnected;
  /** Whether this tab renders for the given summary + viewer capabilities. */
  visible: (s: AppsNavSummary, c: AppsNavContext) => boolean;
};

/**
 * Tab order = discovery → manage → revenue → build → moderate.
 *
 * 🔴 `Build` MOVED FROM FIRST TO SECOND-TO-LAST (before `Review`), and the order is the
 * claim. This bar's leading tab is the one it asserts you came here for, and for the
 * overwhelming majority of viewers that is not authoring: `Build` is gated on
 * `canAccessAppsBuild`, while `Marketplace` and `Activity` are the two consumer
 * surfaces. Leading with `Build` put the narrowest audience's tab in the widest
 * audience's first position. `Review` stays last because it is the moderator surface
 * and reads as the end of the table rather than part of the user's own path.
 *
 * 🔴 EVERY ROW'S PREDICATE IS ITS PAGE'S OWN GATE, RESTATED AS A VIEWER FACT ON
 * {@link AppsNavContext} — never a raw flag read inside the predicate, and never a rule
 * invented here. That is the ONE property this table has to keep. Both defects this
 * file has shipped were the same shape: a tab whose visibility rule was written
 * separately from the gate on the page it points at, and the two drifted. #3899 was
 * "Create" (store-gated tab → author-gated page); PR #4668 found it again on a tab
 * shown to a cohort its page refused; a clean `git` auto-merge once left two rows on
 * the OLD one-argument signature with every test green.
 *
 * "Build" is the strongest form of the fix available: its predicate is not restated
 * here at all, it is the SHARED {@link canAccessAppsBuild}, which the page's
 * `getServerSideProps` calls too. One function, two callers, no spelling to drift.
 *
 * ⚠️ KNOWN, PRE-EXISTING, DELIBERATELY NOT FIXED HERE — issue #3906: `/apps/submit`'s
 * CLIENT BODY carries an extra `if (!features?.appBlocks) return <NotFound />` its own
 * SSR gate does not. `/apps/submit` no longer has a row in this table (its authoring
 * entry point is "Build"), so this bar is no longer a route into it at all; the
 * remaining ways in are the create buttons on `/apps/build` and the `?edit=` deep link
 * from the store card. The outlier is still submit.tsx's body.
 *
 * {@link AppsSubNavView} still hides itself entirely below two tabs — a one-tab
 * "navigation" is chrome that navigates nowhere. 🔴 That floor IS reachable, by a live
 * cohort: a store-visible non-author with no installs and no `appBlocksGetStarted`
 * qualifies for Marketplace ALONE and gets no bar. Unchanged by this consolidation —
 * that viewer had exactly the same one tab before it.
 */
const SUB_NAV_LINKS: SubNavLink[] = [
  /**
   * 🔴 GATED ON STORE ACCESS AS OF THIS CHANGE — it was `() => true`, and that
   * unconditional predicate was a KNOWN, DOCUMENTED 404 exposure (see the note on
   * `AppsNavContext.canSeeStore`): `/apps` gates on `resolveAppsPageAccess`, so a viewer
   * admitted to this bar by the get-started term alone was offered a tab the page
   * answers `notFound` for. It was left open because closing it used to drop that viewer
   * to ONE tab, where the `< 2` collapse hides the bar entirely — deleting the only tab
   * that cohort had. "Build" being store-gated removes that objection: such a viewer now
   * has no `/apps/*` destination at all, so there is nothing to preserve by pointing them
   * at a 404.
   */
  {
    href: '/apps',
    label: 'Marketplace',
    icon: IconBuildingStore,
    visible: (_s, c) => c.canSeeStore,
  },
  /**
   * 🔴 REPOINTED AND RELABELLED: `/apps/installed` → `/apps/activity`, `Installed` →
   * `Activity`. The route 301s (see `next.config.mjs`), the page opens on the activity
   * feed, and its gate widened past the model-slot flag — so "Installed" named one tab
   * of four and refused a cohort that has activity without a single install.
   *
   * 🔴 BOTH TERMS ARE LOAD-BEARING; NEITHER IS A RESTATEMENT OF THE OTHER, AND
   * "SIMPLIFYING" THIS BACK TO `s.hasInstalls` RE-HIDES THE PAGE FROM THE COHORT THE
   * RENAME WIDENED IT FOR. They name two different facts:
   *   • `hasInstalls` — a `block_user_subscriptions` row, i.e. a SLOT install. That is
   *     what the "Installs" tab inside the page shows, and it is what the `appBlocks`
   *     slot flag governs.
   *   • `hasActivity` — a row in either table the FEED walks (`block_buzz_attribution` as
   *     spender, `block_scope_invocations`). A full-page app is STATELESS by design —
   *     `/apps/run`'s own header, Decision 2: "no `block_user_subscriptions` row, no
   *     migration" — so someone who only runs page apps has a populated feed and ZERO
   *     installs. Keyed on installs alone, this row was dark for exactly them: the page
   *     admitted them (`appBlocks || appBlocksPages`) and no tab pointed at it.
   * An install with no usage yet is the mirror case, which is why the OR keeps both.
   *
   * ⚠️ A RESIDUAL NARROWNESS SURVIVES, deliberately, and it is the SAFE direction of the
   * #3899 / #4668 class (an unreachable page, never a tab into a 404): both flags come
   * from `getNavSummary`, whose `enabled` and whose server middleware are gated on
   * `appBlocks`, while the page admits `appBlocks || appBlocksPages`. A viewer holding
   * `appBlocksPages` WITHOUT `appBlocks` still gets an all-false summary and no tab.
   * Closing that means moving the procedure's own gate, which is a wider blast radius
   * than this row (every flag on the summary would widen with it).
  // ⚠️ …AND THAT RESIDUAL IS NARROWER THAN THE SENTENCE ABOVE IMPLIES — corrected after an
  // audit, because as written it invites a future widening of a `blocks.*` flag gate to
  // close a gap that is effectively EMPTY. That cohort is refused by `/apps/run` itself
  // (`[[...path]].tsx` requires BOTH `appBlocks` and `appBlocksPages`) and cannot install
  // (slot installs are `appBlocks`-gated), so going forward they can generate NO activity
  // at all: an all-false summary is the CORRECT tab set for them, not a deprivation. The
  // only way they hold rows is a historical `appBlocks` grant since revoked. Do not widen
  // the procedure's gate for this.
   */
  {
    href: '/apps/activity',
    label: 'Activity',
    icon: IconPlugConnected,
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
    href: '/apps/invites',
    label: 'Invites',
    icon: IconMail,
    visible: (s, c) => c.isAuthor && s.hasPendingInvites,
  },
  {
    href: '/apps/revenue',
    // INTENTIONAL mismatch: this tab is keyed on app OWNERSHIP (hasApprovedApps),
    // but `/apps/revenue` itself gates on `isAppDeveloper` (mod). An owner who
    // isn't a mod sees the tab but the page enforces access — don't "fix" this
    // by aligning them; the tab is an ownership affordance, the page is the
    // access boundary. (Pre-GA, ownership ⊆ mod, so both resolve the same.)
    label: 'Revenue',
    icon: IconCurrencyDollar,
    visible: (s) => s.hasApprovedApps,
  },
  /**
   * The consolidated BUILD surface — the ONLY authoring entry in this bar.
   *
   * 🔴 IT USED TO LEAD THE TABLE, ON THE ARGUMENT THAT IT IS "the front door for someone
   * who has not built anything yet". That sentence is now false and is not merely
   * relocated: the row sits second-to-last, and the reason is on the table's own
   * docstring — its audience is the narrowest of any consumer tab here, so leading with
   * it put the smallest cohort's destination in the position that reads as "what this
   * page is for". The front-door claim was always about the PITCH (state A of
   * `/apps/build`), which is one of three states the row resolves to.
   *
   * 🔴 THIS ROW REPLACED THREE: "Build apps" (`/apps/get-started`), "Create"
   * (`/apps/submit`) and "My apps" (`/apps/mine`). Those three were largely one another's
   * content — get-started was static marketing whose every CTA pointed off-platform, and
   * `/apps/submit`'s on-platform branch was the same copy-paste wall a second time — so a
   * developer's path was three tabs that mostly showed each other. `/apps/build` is
   * state-aware instead: pitch → first-app → workbench. The two retired routes 301 to it;
   * `/apps/submit` KEEPS its route (the `?edit=<listingId>` deep link from the store card
   * and the listing-detail ⋮ menus resolves there via `getOwnerEditHref`) and simply
   * stops having a tab.
   *
   * 🔴 NOT `c.isAuthor`, AND NOT `!!features.appBlocksGetStarted` — `c.canBuild`, which
   * is {@link canAccessAppsBuild} verbatim. `hasSubmissions` / `hasEditableApps` are
   * deliberately ABSENT from this predicate even though they decide what the page
   * RENDERS: they come from the client-only `getNavSummary`, and a tab that appeared
   * after mount for an author with apps is the tab-set hydration mismatch this file
   * already survived once. The page's own state machine reads them; the tab does not
   * need to.
   *
   * Hydration-safe for the reason written out on the predicate: all of its inputs are
   * SSR-seeded and frozen, and neither `appBlocksAuthor` nor `appBlocksGetStarted` is
   * `toggleable`, so `computeUserFeatureFlagsOverlay` cannot move them between the
   * server render and the first client paint.
   */
  {
    href: '/apps/build',
    label: 'Build',
    icon: IconCode,
    visible: (_s, c) => c.canBuild,
  },
  { href: '/apps/review', label: 'Review', icon: IconGavel, visible: (s) => s.isReviewer },
];

/**
 * Returns true when `current` is on the `href` route. `/apps` (the
 * marketplace) must match EXACTLY so it isn't lit on every `/apps/*` child;
 * the sub-routes match on prefix so deep paths (e.g. `/apps/activity/<x>`
 * or `/apps/run/<slug>` under the parent) keep the right tab active.
 */
export function isActiveAppsRoute(href: string, current: string): boolean {
  if (href === '/apps') return current === '/apps';
  return current === href || current.startsWith(`${href}/`);
}

/**
 * The href of the tab that should be active for `currentPath`, or `null` when
 * none matches (a deep `/apps/*` route with no corresponding tab leaves the bar
 * with no active tab rather than mis-lighting one). Drives `Tabs.value`.
 */
export function activeAppsTab(currentPath: string): string | null {
  return SUB_NAV_LINKS.find((l) => isActiveAppsRoute(l.href, currentPath))?.href ?? null;
}

/**
 * Pure presentational sub-nav. Kept separate from the data-fetching container
 * so it can be rendered in isolation (props-only) under test and reused if a
 * caller already has the summary in hand.
 *
 * Rendered with the Mantine navigation **Tabs** LOOK (active underline driven by
 * `Tabs.value`), but wrapped in a real `<nav aria-label="App sections">` so it's
 * exposed as a navigation LANDMARK — this is cross-page navigation, not a
 * single-page tab panel, so the landmark (not a bare `role="tablist"`) is the
 * correct semantics. Each tab is a real Next `Link` (`renderRoot` → `<a href>`)
 * so keyboard / middle-click / SEO affordances of an anchor survive while Tabs
 * owns the active styling + `aria-selected`. Navigation is the anchor's job;
 * there's no `onChange` (the route is the single source of truth, so clicking
 * just follows the link and the new route lights the matching tab).
 *
 * Renders NOTHING when fewer than two tabs qualify (moderators included). A
 * single-entry "navigation" bar is pure chrome — it can only link to the page
 * you are already on — and it still costs the tab row's height plus its bottom
 * rule on every `/apps/*` surface. Two is the floor at which the bar is a
 * navigation affordance rather than a decoration.
 *
 * `activateTabWithKeyboard={false}`: Mantine's default arrow-key handler
 * synthesizes a `.click()` on the focused tab, which on these real `<Link>`
 * anchors triggers a full page navigation — so a keyboard user can't ARROW to
 * scan the nav without being yanked to another page. Disabling it lets arrow
 * keys move focus only; Enter/Space on a focused tab still navigates natively
 * (it's a real anchor).
 */
export function AppsSubNavView({
  summary,
  context,
  currentPath,
}: {
  summary: AppsNavSummary;
  context: AppsNavContext;
  currentPath: string;
}) {
  const links = SUB_NAV_LINKS.filter((l) => l.visible(summary, context));
  // Fewer than two qualifying tabs ⇒ no navigation bar at all. Applies to every
  // viewer, moderators included.
  if (links.length < 2) return null;
  const active = activeAppsTab(currentPath);
  return (
    <Box component="nav" aria-label="App sections" w="100%">
      <ScrollArea type="never" w="100%">
        <Tabs
          value={active}
          variant="default"
          w="100%"
          activateTabWithKeyboard={false}
          // VERTICAL padding only. Mantine's default Tab padding is the shorthand
          // `var(--mantine-spacing-xs) var(--mantine-spacing-md)` = 10px block /
          // 16px inline, giving a 37px tab row. `paddingBlock` overrides ONLY the
          // block axis, so the 16px inline padding from that shorthand survives
          // untouched and the tabs keep their horizontal hit area and rhythm.
          // 6px → a 29px row (measured, 1440 render): still clears WCAG 2.5.8
          // Target Size (Minimum, AA) — 24×24 CSS px — with the anchor's full
          // width as the horizontal target.
          //
          // 🔴 This does NOT touch the grouping below the tabs. The separator is
          // `Tabs.List::before` (a 2px bar pinned to the LIST's bottom edge — not
          // the tab's own border-bottom, which is a transparent active-indicator
          // slot). The list is exactly as tall as its tabs, so shrinking the tab
          // shrinks the list and the rule travels UP with it, while
          // `AppsPageLayout`'s `Stack gap="md"` holds the rule↔title gap at a
          // fixed 16px. If anything it tightens the band: the tab LABEL sits 6px
          // above the rule instead of 10px, so label↔title goes 26px → 22px
          // against an unchanged 32px band↔body.
          styles={{ tab: { paddingBlock: rem(6) } }}
        >
          <Tabs.List style={{ flexWrap: 'nowrap' }}>
            {links.map((link) => {
              const Icon = link.icon;
              return (
                <Tabs.Tab
                  key={link.href}
                  value={link.href}
                  // `renderRoot` (not `component`) is the Mantine-blessed way to
                  // mount a typed Next `<Link>` as the polymorphic root without the
                  // generic-component TS2322 — keeps the tab a real anchor (href,
                  // keyboard, middle-click) while Tabs owns role/aria-selected.
                  renderRoot={(props) => <Link href={link.href} {...props} />}
                  leftSection={<Icon size={15} />}
                >
                  {link.label}
                </Tabs.Tab>
              );
            })}
          </Tabs.List>
        </Tabs>
      </ScrollArea>
    </Box>
  );
}

/**
 * In-page sub-nav for the `/apps/*` surfaces. Renders the conditional tab set
 * from `blocks.getNavSummary` and highlights the active route. Mounts at the
 * top of every apps page (the nav dropdown now exposes a single `/apps`
 * entry — this is the second-level navigation).
 *
 * Gated on `hasAppsStoreAccess(features)` — the SAME rule `resolveAppsPageAccess`
 * enforces. It carried an extra `|| features.appBlocksGetStarted` term until the
 * `/apps/build` consolidation; see the gate itself for the proof that dropping it is a
 * no-op, and for the hydration argument.
 *
 * 🔴 THE `<2` COLLAPSE STILL FIRES, FOR THE SAME COHORT AS BEFORE: a store-visible
 * non-author with no installs and no `appBlocksGetStarted` qualifies for Marketplace
 * ALONE and gets no chrome. Unchanged by the Build consolidation — that viewer had
 * exactly one tab before it too.
 *
 * 🔴 THE RESIDUAL MARKETPLACE-404 EXPOSURE THIS DOCSTRING USED TO DESCRIBE IS CLOSED.
 * Marketplace is `visible: (_s, c) => c.canSeeStore` now, not `() => true`, so a viewer
 * admitted by the get-started term alone is no longer offered a tab `/apps` answers
 * `notFound` for. What made that fixable was "Build" becoming store-gated: closing it
 * used to strand that cohort with zero usable tabs, and now they have zero either way.
 *
 * 🔴 THIS GATE USED TO READ `features.appBlocks` ALONE while the page it sits on
 * granted access on `appListings || appBlocks`. The two could therefore disagree:
 * a cohort holding `app-listings` WITHOUT `app-blocks-enabled` would load `/apps`
 * successfully and get NO sub-navigation. That is not reachable today — in Flipt
 * `app-listings` and `app-blocks-enabled` roll out to the SAME two segments,
 * `moderators` and `app-dev-testers` (the same coincidence written up in full, with
 * what would end it, at `OWNER_SUBMISSIONS_URL` in
 * `~/server/notifications/app-listing.notifications`) — but `app-listings` exists
 * precisely so the catalog can widen INDEPENDENTLY of the block runtime, so the
 * disagreement is one segment edit away. Both gates now call one predicate.
 */
export function AppsSubNav() {
  const router = useRouter();
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  // 🔴 HYDRATION-SAFE tab set. The CONDITIONAL tabs are driven by the client-only
  // `getNavSummary` query, whose data is present in the CLIENT's very first render
  // but ABSENT during SSR (tRPC runs with `ssr: false`, so the server always
  // renders `EMPTY_SUMMARY` = the two always-on tabs). Rendering the resolved
  // summary on the first client paint therefore produced a DIFFERENT tab set than
  // the server HTML (e.g. 2 tabs SSR vs 6 tabs client for a user with
  // installs/submissions/approved-apps/reviewer status) — a React hydration
  // mismatch (#418/#425) that bails hydration of the ENTIRE /apps page root,
  // leaving every /apps page un-hydrated and inert (dead buttons, queries that
  // never fire). Gate on `useIsClient()` so the server AND the first client paint
  // both render the deterministic always-on set; the conditional tabs reveal only
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
  // airtight. It read: the conditional tabs "all point at pages that themselves 404
  // without `appBlocks`, so all-false is also the CORRECT tab set for that viewer."
  // `/apps/activity` NO LONGER 404s without `appBlocks` — it gates on
  // `canAccessAppsActivity` = `appBlocks || appBlocksPages`. So for a viewer holding
  // `appBlocksPages` but not `appBlocks`, all-false is NOT the correct tab set: the page
  // would serve them and this gate hides the only route to it. That is the residual
  // narrowness recorded on the Activity row, and it is the SAFE direction (an
  // unreachable page, not a tab into a 404) — but do not re-derive the retired claim as
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
  // bar. After the consolidation EVERY row in `SUB_NAV_LINKS` implies store access:
  //   • Build      — `canAccessAppsBuild` has `hasAppsStoreAccess` as a hard AND;
  //   • Marketplace— `c.canSeeStore` IS `hasAppsStoreAccess`;
  //   • Activity / Invites / Revenue / Review — all driven by `getNavSummary`, whose
  //     `enabled` requires `features.appBlocks`, and `appBlocks` is one of the three
  //     disjuncts of `hasAppsStoreAccess`, so the summary is all-false without it.
  // So a viewer this gate would have admitted on the second term alone qualifies for ZERO
  // rows and the `< 2` collapse returns `null` a moment later regardless. Same observable
  // output, one less rule.
  //
  // ⚠️ THE JUSTIFICATION FOR KEEPING IT WAS DRAFTED AND WAS WRONG — recorded because it is
  // the plausible-sounding reason someone will re-add it. It ran: "Invites keys on
  // `c.isAuthor`, so an author with no store flags would lose their invite tab." That
  // author does not HAVE an invite tab: `hasPendingInvites` comes from a query gated on
  // `appBlocks`, so it is false for them either way. Check what actually feeds a row
  // before arguing a container gate protects it.
  //
  // 🔴 SAFE ON THE FIRST PAINT. The term is SSR-seeded and FROZEN: resolved server-side in
  // `_app`'s `getInitialProps` (`getFeatureFlagsAsync({ user: session.user, … })`, Flipt
  // included), serialized into `pageProps.flags`, frozen by `useState(initialFlags)` in
  // `FeatureFlagsProvider`, and none of the three store flags is `toggleable: true` — so
  // `computeUserFeatureFlagsOverlay` never emits them and the client
  // `user.getFeatureFlags` overlay cannot move them.
  if (!hasAppsStoreAccess(features)) return null;

  const summary = isClient ? data ?? EMPTY_SUMMARY : EMPTY_SUMMARY;

  // 🔴 NOT gated on `useIsClient()` — deliberately, and verified against the
  // incident above rather than assumed. All THREE inputs are SSR-seeded and FROZEN,
  // so this value is byte-identical on the server render and the first client
  // render, which is the whole condition for hydration safety:
  //   • `features.appBlocksAuthor` and `features.appBlocksGetStarted` are both
  //     resolved server-side in `_app`'s
  //     `getInitialProps` (`getFeatureFlagsAsync({ user: session.user, … })`,
  //     Flipt included), serialized into `pageProps.flags`, and frozen by
  //     `useState(initialFlags)` in `FeatureFlagsProvider`. NEITHER is a
  //     `toggleable: true` flag, so `computeUserFeatureFlagsOverlay` never emits
  //     them and the client `user.getFeatureFlags` overlay cannot move them.
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
  // the fix for the defect class this file keeps hitting: a tab predicate written
  // separately from its page's gate WILL drift, and both #3899 and PR #4668 were that
  // drift caught late. Do not "simplify" this to a flag read.
  //
  // 🔴 IT IS NOT SESSION-SCOPED, unlike `isAuthor`, and that asymmetry is deliberate
  // rather than an oversight. `isAppDeveloper` reads `isModerator`, so `isAuthor`
  // collapses to `false` without a session; `canAccessAppsBuild` takes the user as an
  // argument and handles the anon case ITSELF (the `appBlocksGetStarted` term consults
  // no user), so folding it into the `currentUser` branch would hide the tab from a
  // logged-out viewer the PAGE would happily serve state A to.
  const context: AppsNavContext = {
    isAuthor: currentUser
      ? isAppDeveloper(currentUser, { appBlocksAuthor: features.appBlocksAuthor })
      : NO_CAPABILITIES.isAuthor,
    canBuild: canAccessAppsBuild(currentUser, features),
    canSeeStore: hasAppsStoreAccess(features),
  };

  return <AppsSubNavView summary={summary} context={context} currentPath={router.pathname} />;
}
