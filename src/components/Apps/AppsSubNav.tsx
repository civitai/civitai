import { Box, rem, ScrollArea, Tabs } from '@mantine/core';
import {
  IconApps,
  IconBuildingStore,
  IconCurrencyDollar,
  IconGavel,
  IconMail,
  IconPlugConnected,
  IconSquarePlus,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useIsClient } from '~/providers/IsClientProvider';
import { hasAppsStoreAccess, isAppDeveloper } from '~/shared/utils/app-blocks-access';

/**
 * The conditions that drive which sub-nav tabs are visible. Sourced from the
 * single lightweight `blocks.getNavSummary` query (booleans only — no rows) so
 * the sub-nav doesn't fan out to the heavyweight per-page queries
 * (`listMySubscriptions` / `listMyPublishRequests` / `getMyApps`) just to pick
 * which tabs to show.
 */
export type AppsNavSummary = {
  /** ≥1 install/subscription → show "Installed". */
  hasInstalls: boolean;
  /**
   * ≥1 publish request. Used to drive its own "My submissions" tab; that page merged into
   * `/apps/mine`, so this now widens "My apps" — see the 🔴 note on that entry.
   */
  hasSubmissions: boolean;
  /** ≥1 owned app in the `approved` state → show "Revenue". */
  hasApprovedApps: boolean;
  /** app reviewer (mod) → show "Review". */
  isReviewer: boolean;
  /**
   * ≥1 listing owned OR held via an ACCEPTED collaborator seat → show "My apps".
   *
   * 🔴 The seat half is why this cannot be folded into `hasSubmissions`: a collaborator
   * has submitted nothing, so every other flag on this summary is `false` for them and
   * there would be no nav route to an app they can genuinely edit.
   */
  hasEditableApps: boolean;
  /** ≥1 PENDING invitation → show "Invites". True for someone who owns nothing. */
  hasPendingInvites: boolean;
};

const EMPTY_SUMMARY: AppsNavSummary = {
  hasInstalls: false,
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
   * May AUTHOR apps (submit / `dev:live`) → show "Create". Resolved via the
   * shared {@link isAppDeveloper} predicate — moderators are a hard floor, the
   * `appBlocksAuthor` capability widens it to the curated non-mod cohort.
   */
  isAuthor: boolean;
};

/** No capabilities — the shape a logged-out / non-author viewer resolves to. */
const NO_CAPABILITIES: AppsNavContext = { isAuthor: false };

type SubNavLink = {
  href: string;
  label: string;
  icon: typeof IconPlugConnected;
  /** Whether this tab renders for the given summary + viewer capabilities. */
  visible: (s: AppsNavSummary, c: AppsNavContext) => boolean;
};

/**
 * Tab order = discovery → author → manage → revenue → moderate.
 *
 * Only **Marketplace** is unconditional. "Create" links at `/apps/submit`,
 * whose `getServerSideProps` gates on `features.appBlocksAuthor` +
 * `isAppDeveloper` and otherwise returns `notFound` — so a store-visible
 * NON-author (the widened `app-listings` tester cohort: `app-listings=true`,
 * `app-blocks-author=false`) would click a tab straight into a 404. The tab now
 * keys off the SAME predicate the page's `getServerSideProps` does.
 *
 * ⚠️ KNOWN, PRE-EXISTING, DELIBERATELY NOT FIXED HERE — tracked in issue #3906:
 * `/apps/submit`'s CLIENT BODY carries an EXTRA
 * `if (!features?.appBlocks) return <NotFound />` (submit.tsx:68) that its own SSR
 * gate does NOT. That check was always reachable by DIRECT navigation (a bookmark,
 * a pasted link, the `?edit=` deep link from my-submissions); what the old
 * `appBlocks` gate on this container prevented was reaching it *via this tab*.
 * Now that the container is on the shared STORE predicate, the tab is one more
 * route into it for the cohort {`appListings` yes, `appBlocks` no, author} — empty
 * today, since `app-blocks-author` is a strict subset of `app-blocks-enabled`.
 * The outlier is submit.tsx's body, not this tab: re-inlining `appBlocks` here
 * would re-create the very drift this change removes, and whether authoring
 * requires the block runtime is a product decision. See #3906.
 *
 * With "Create" conditional the bar can collapse to a single entry, so
 * {@link AppsSubNavView} hides itself entirely below two tabs — a one-tab
 * "navigation" is chrome that navigates nowhere.
 */
const SUB_NAV_LINKS: SubNavLink[] = [
  { href: '/apps', label: 'Marketplace', icon: IconBuildingStore, visible: () => true },
  {
    href: '/apps/submit',
    label: 'Create',
    icon: IconSquarePlus,
    visible: (_s, c) => c.isAuthor,
  },
  {
    href: '/apps/installed',
    label: 'Installed',
    icon: IconPlugConnected,
    visible: (s) => s.hasInstalls,
  },
  /**
   * 🔴 BOTH OF THESE NEED `c.isAuthor` AS WELL AS THEIR SUMMARY FLAG, for exactly the
   * reason #3899 gave for "Create" — and the merge that brought the two changes together
   * is where this could have been missed. `git` auto-merged this table cleanly: main
   * added the `context` argument and gated Create on it; this branch added these two
   * entries against the OLD one-argument signature. The result compiled, every test
   * passed, and both tabs were left un-gated.
   *
   * `/apps/mine` and `/apps/invites` both `getServerSideProps`-gate on
   * `features.appBlocksAuthor` + `isAppDeveloper` and otherwise return `notFound`. The
   * summary that drives them does NOT: `blocks.getNavSummary` is gated on the
   * marketplace `appBlocks` flag, not the author one — so a store-visible NON-author
   * (`app-listings=true`, `app-blocks-author=false`, the cohort #3899 was written for)
   * can legitimately have both flags set and would click straight into a 404.
   *
   * Reachable on both: `inviteCollaborator` accepts ANY existing, non-banned user id as
   * the target — nothing requires the invitee to be an author — so `hasPendingInvites`
   * goes true for a non-author whenever an owner invites them. `hasEditableApps` is the
   * slower path: an owner who loses the author capability keeps their listings, which is
   * the same cohort-widening scenario #3899 describes.
   *
   * (The pre-existing `Revenue` entry below deliberately does NOT do this — see its own
   * comment. That is a recorded decision about an OWNERSHIP affordance, not an oversight,
   * and it is left exactly as main has it.)
   */
  /**
   * 🔴 `hasSubmissions` IS PART OF THIS PREDICATE BECAUSE THIS TAB ABSORBED "My
   * submissions". That tab was `visible: (s) => s.hasSubmissions` and pointed at
   * `/apps/my-submissions`, which now 301s here. Dropping it while leaving this entry on
   * `hasEditableApps` alone would remove the only nav route for anyone whose submission
   * history outlives their editable set — a submitter whose every listing was deleted, for
   * instance. The union is what makes the merge lossless in the nav as well as the page.
   *
   * `c.isAuthor` is kept (and is NEW relative to the old submissions tab) for the reason
   * #3899 gave: `/apps/mine` `getServerSideProps`-gates on `features.appBlocksAuthor` +
   * `isAppDeveloper` and otherwise 404s, while the summary driving it is gated on the
   * marketplace `appBlocks` flag — so a store-visible non-author could otherwise click
   * straight into a 404.
   */
  {
    href: '/apps/mine',
    label: 'My apps',
    icon: IconApps,
    visible: (s, c) => c.isAuthor && (s.hasEditableApps || s.hasSubmissions),
  },
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
  { href: '/apps/review', label: 'Review', icon: IconGavel, visible: (s) => s.isReviewer },
];

/**
 * Returns true when `current` is on the `href` route. `/apps` (the
 * marketplace) must match EXACTLY so it isn't lit on every `/apps/*` child;
 * the sub-routes match on prefix so deep paths (e.g. `/apps/installed?tab=...`
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
 * Gated on the SHARED store-visibility predicate `hasAppsStoreAccess(features)`
 * — the SAME rule `resolveAppsPageAccess` enforces in `getServerSideProps` — and
 * on a logged-in user (the summary query is a `protectedProcedure`; an anon
 * viewer resolves to `NO_CAPABILITIES` + an empty summary ⇒ Marketplace alone ⇒
 * the bar hides itself entirely).
 *
 * 🔴 THIS GATE USED TO READ `features.appBlocks` ALONE while the page it sits on
 * granted access on `appListings || appBlocks`. The two could therefore disagree:
 * a cohort holding `app-listings` WITHOUT `app-blocks-enabled` would load `/apps`
 * successfully and get NO sub-navigation. That is not reachable today (both flags
 * resolve true for the current mods + `app-dev-testers` cohort), but `app-listings`
 * exists precisely so the catalog can widen INDEPENDENTLY of the block runtime, so
 * the disagreement is one flag flip away. Both gates now call one predicate.
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
  // The conditional tabs it feeds (Installed / My submissions / Revenue / Review)
  // all point at pages that themselves 404 without `appBlocks`, so all-false is
  // also the CORRECT tab set for that viewer. If the server proc ever moves to
  // `enforceAppListingsReadFlag`, move this with it.
  const { data } = trpc.blocks.getNavSummary.useQuery(undefined, {
    enabled: !!features.appBlocks && !!currentUser,
    staleTime: 60_000,
  });

  if (!hasAppsStoreAccess(features)) return null;

  const summary = isClient ? data ?? EMPTY_SUMMARY : EMPTY_SUMMARY;

  // 🔴 NOT gated on `useIsClient()` — deliberately, and verified against the
  // incident above rather than assumed. Both inputs are SSR-seeded and FROZEN,
  // so this value is byte-identical on the server render and the first client
  // render, which is the whole condition for hydration safety:
  //   • `features.appBlocksAuthor` is resolved server-side in `_app`'s
  //     `getInitialProps` (`getFeatureFlagsAsync({ user: session.user, … })`,
  //     Flipt included), serialized into `pageProps.flags`, and frozen by
  //     `useState(initialFlags)` in `FeatureFlagsProvider`. It is NOT a
  //     `toggleable: true` flag, so `computeUserFeatureFlagsOverlay` never emits
  //     it and the client `user.getFeatureFlags` overlay cannot move it.
  //   • `currentUser.isModerator` rides `SessionProvider`'s `useState(initial)`,
  //     seeded from the same SSR `pageProps.session`. When that seed is
  //     `undefined` (auth cookie present, session unresolved) the SERVER also
  //     rendered without a user, so the first client paint still matches — the
  //     session only arrives in a LATER render, post-hydration.
  // Contrast `getNavSummary` above, which really is client-only and therefore
  // really does need the `isClient` deferral.
  const context: AppsNavContext = currentUser
    ? { isAuthor: isAppDeveloper(currentUser, { appBlocksAuthor: features.appBlocksAuthor }) }
    : NO_CAPABILITIES;

  return <AppsSubNavView summary={summary} context={context} currentPath={router.pathname} />;
}
