import {
  IconLayoutDashboard,
  IconSpeakerphone,
  IconLicense,
  IconCoin,
  IconChartBar,
  IconSettings,
  IconSparkles,
  IconShieldLock,
} from '@tabler/icons-svelte';

// Single source for both the desktop sidebar and mobile header (plan §3), icon component included so there's no
// name→component lookup to keep in sync. memberOnly is a display hint only; enforcement is per-action in
// $lib/server/membership.ts. Because items carry a component, nav is built client-side (see +layout.svelte) —
// not returned from a server load, which can't serialize a component.
type NavIcon = typeof IconLayoutDashboard;

export type NavChild = { href: string; label: string; flag?: string };
/** The flag gating the Sales subpage — the same key its route and every one of its actions read. */
export const SALES_FLAG = 'scheduled-model-sales';

export type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  memberOnly?: boolean;
  nonMemberOnly?: boolean;
  // Hidden unless the named feature flag resolved true for this user (see +layout.server.ts).
  flag?: string;
  // Display hint only — the gate is the /admin layout load.
  adminOnly?: boolean;
  // Sub-pages shown nested in the sidebar when this section is active.
  children?: NavChild[];
};

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: IconLayoutDashboard },
  {
    href: '/models',
    label: 'Monetization',
    icon: IconLicense,
    memberOnly: true,
    children: [
      { href: '/models', label: 'Models' },
      { href: '/sales', label: 'Sales', flag: SALES_FLAG },
    ],
  },
  { href: '/earnings', label: 'Earnings', icon: IconCoin },
  {
    href: '/analytics',
    label: 'Analytics',
    icon: IconChartBar,
    children: [
      { href: '/analytics', label: 'Overview' },
      { href: '/analytics/models', label: 'Models' },
      { href: '/analytics/base-models', label: 'Base models' },
      { href: '/analytics/engagement', label: 'Engagement' },
      { href: '/analytics/content', label: 'Content' },
      { href: '/analytics/audience', label: 'Audience' },
    ],
  },
  {
    href: '/announcements',
    label: 'Announcements',
    icon: IconSpeakerphone,
    flag: 'creator-announcements',
  },
  { href: '/admin', label: 'Admin', icon: IconShieldLock, adminOnly: true },
  { href: '/settings', label: 'Settings', icon: IconSettings },
  { href: '/join', label: 'Join Creator Program', icon: IconSparkles, nonMemberOnly: true },
];

// A child is active on its exact route or any nested route below it. A child that IS its section's own
// href (Analytics Overview, Monetization Models) matches exactly, so a sibling subpage doesn't light both.
const SECTION_HREFS = new Set(['/analytics', '/models']);

export function isNavChildActive(href: string, pathname: string): boolean {
  if (SECTION_HREFS.has(href)) return pathname === href;
  return pathname === href || pathname.startsWith(href + '/');
}

export function isNavActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  if (pathname === href || pathname.startsWith(href + '/')) return true;
  // A section is also active on a child that lives outside its own path — /sales belongs to Monetization,
  // and without this the sidebar collapses the section the creator is standing in.
  const item = NAV.find((n) => n.href === href);
  return !!item?.children?.some((c) => c.href !== href && isNavChildActive(c.href, pathname));
}

// Longest matching href wins (e.g. a future `/settings/x` highlights `/settings`, not `/`).
export function activeNavHref(pathname: string): string | undefined {
  return NAV.map((n) => n.href)
    .filter((href) => isNavActive(href, pathname))
    .sort((a, b) => b.length - a.length)[0];
}

// `isMember` here is the Creator Program gate (B1) — the single bar the Studio's member-only surfaces key on,
// not subscription tier. Callers pass `membership.isCreatorProgramMember`.
export function navForMember(
  isMember: boolean,
  enabledFlags: string[] = [],
  isAdmin = false
): NavItem[] {
  const allowed = (flag?: string) => !flag || enabledFlags.includes(flag);
  return (
    NAV.filter((item) => (item.adminOnly ? isAdmin : true))
      .filter((item) => (item.nonMemberOnly ? !isMember : true))
      .filter((item) => allowed(item.flag))
      // A flagged-off child is dropped, not disabled: a link whose page answers "not available on your
      // account" is a worse gate than no link. Children are filtered as well as items because a section
      // can be unflagged while one of its subpages is not — Monetization is open, Sales is gated.
      .map((item) =>
        item.children ? { ...item, children: item.children.filter((c) => allowed(c.flag)) } : item
      )
  );
}
