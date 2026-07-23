import {
  IconLayoutDashboard,
  IconLicense,
  IconCoin,
  IconChartBar,
  IconSettings,
  IconSparkles,
} from '@tabler/icons-svelte';

// Single source for both the desktop sidebar and mobile header (plan §3), icon component included so there's no
// name→component lookup to keep in sync. memberOnly is a display hint only; enforcement is per-action in
// $lib/server/membership.ts. Because items carry a component, nav is built client-side (see +layout.svelte) —
// not returned from a server load, which can't serialize a component.
type NavIcon = typeof IconLayoutDashboard;

export type NavChild = { href: string; label: string };
export type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  memberOnly?: boolean;
  nonMemberOnly?: boolean;
  // Sub-pages shown nested in the sidebar when this section is active.
  children?: NavChild[];
};

export const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: IconLayoutDashboard },
  { href: '/models', label: 'Licensing', icon: IconLicense, memberOnly: true },
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
  { href: '/settings', label: 'Settings', icon: IconSettings },
  { href: '/join', label: 'Join Creator Program', icon: IconSparkles, nonMemberOnly: true },
];

// A child is active on its exact route (Overview = /analytics exactly) or any nested route below it.
export function isNavChildActive(href: string, pathname: string): boolean {
  if (href === '/analytics') return pathname === '/analytics';
  return pathname === href || pathname.startsWith(href + '/');
}

export function isNavActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

// Longest matching href wins (e.g. a future `/settings/x` highlights `/settings`, not `/`).
export function activeNavHref(pathname: string): string | undefined {
  return NAV.map((n) => n.href)
    .filter((href) => isNavActive(href, pathname))
    .sort((a, b) => b.length - a.length)[0];
}

// `isMember` here is the Creator Program gate (B1) — the single bar the Studio's member-only surfaces key on,
// not subscription tier. Callers pass `membership.isCreatorProgramMember`.
export function navForMember(isMember: boolean): NavItem[] {
  return NAV.filter((item) => (item.nonMemberOnly ? !isMember : true));
}
