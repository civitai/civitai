import { Box, ScrollArea, Tabs } from '@mantine/core';
import {
  IconBuildingStore,
  IconCurrencyDollar,
  IconGavel,
  IconListDetails,
  IconPlugConnected,
  IconUpload,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

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
  /** ≥1 publish request → show "My submissions". */
  hasSubmissions: boolean;
  /** ≥1 owned app in the `approved` state → show "Revenue". */
  hasApprovedApps: boolean;
  /** app reviewer (mod) → show "Review". */
  isReviewer: boolean;
};

const EMPTY_SUMMARY: AppsNavSummary = {
  hasInstalls: false,
  hasSubmissions: false,
  hasApprovedApps: false,
  isReviewer: false,
};

type SubNavLink = {
  href: string;
  label: string;
  icon: typeof IconPlugConnected;
  /** Whether this tab renders for the given summary. */
  visible: (s: AppsNavSummary) => boolean;
};

/**
 * Tab order = discovery → author → manage → revenue → moderate. The two
 * always-on tabs (Marketplace + Submit) lead so the bar never collapses to
 * fewer than two entries.
 */
const SUB_NAV_LINKS: SubNavLink[] = [
  { href: '/apps', label: 'Marketplace', icon: IconBuildingStore, visible: () => true },
  { href: '/apps/submit', label: 'Submit', icon: IconUpload, visible: () => true },
  {
    href: '/apps/installed',
    label: 'Installed',
    icon: IconPlugConnected,
    visible: (s) => s.hasInstalls,
  },
  {
    href: '/apps/my-submissions',
    label: 'My submissions',
    icon: IconListDetails,
    visible: (s) => s.hasSubmissions,
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
 * `activateTabWithKeyboard={false}`: Mantine's default arrow-key handler
 * synthesizes a `.click()` on the focused tab, which on these real `<Link>`
 * anchors triggers a full page navigation — so a keyboard user can't ARROW to
 * scan the nav without being yanked to another page. Disabling it lets arrow
 * keys move focus only; Enter/Space on a focused tab still navigates natively
 * (it's a real anchor).
 */
export function AppsSubNavView({
  summary,
  currentPath,
}: {
  summary: AppsNavSummary;
  currentPath: string;
}) {
  const links = SUB_NAV_LINKS.filter((l) => l.visible(summary));
  const active = activeAppsTab(currentPath);
  return (
    <Box component="nav" aria-label="App sections" w="100%">
      <ScrollArea type="never" w="100%">
        <Tabs value={active} variant="default" w="100%" activateTabWithKeyboard={false}>
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
 * Gated on `features.appBlocks` (the page itself 404s without it, so this is a
 * belt for non-flag callers) and on a logged-in user (the summary query is a
 * `protectedProcedure`; anon viewers — once the segment widens — just see the
 * two always-on tabs).
 */
export function AppsSubNav() {
  const router = useRouter();
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();

  const { data } = trpc.blocks.getNavSummary.useQuery(undefined, {
    enabled: !!features.appBlocks && !!currentUser,
    staleTime: 60_000,
  });

  if (!features.appBlocks) return null;

  return <AppsSubNavView summary={data ?? EMPTY_SUMMARY} currentPath={router.pathname} />;
}
