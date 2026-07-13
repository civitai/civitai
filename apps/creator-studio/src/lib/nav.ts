// Single source for both the desktop sidebar and mobile header (plan §3). memberOnly is a display hint only;
// enforcement is per-action in $lib/server/membership.ts.

export type NavItem = {
  href: string;
  label: string;
  /** Tabler icon name, resolved to a component in +layout.svelte. */
  icon: string;
  memberOnly?: boolean;
  nonMemberOnly?: boolean;
};

export const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: 'dashboard' },
  { href: '/models', label: 'Models', icon: 'box', memberOnly: true },
  { href: '/earnings', label: 'Earnings', icon: 'coin' },
  { href: '/earnings/analytics', label: 'Analytics', icon: 'chart' },
  { href: '/licensing', label: 'Licensing', icon: 'license', memberOnly: true },
  { href: '/settings', label: 'Settings', icon: 'settings' },
  { href: '/join', label: 'Join Creator Program', icon: 'sparkles', nonMemberOnly: true },
];

export function isNavActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

// Longest matching href wins, so `/earnings/analytics` highlights over `/earnings`.
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
