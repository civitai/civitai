import { IconCoin, IconLayoutDashboard } from '@tabler/icons-svelte';

type NavIcon = typeof IconLayoutDashboard;

export type AdminNavItem = { href: string; label: string; icon: NavIcon };

export const ADMIN_NAV: AdminNavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: IconLayoutDashboard },
  { href: '/admin/monetization', label: 'Monetization', icon: IconCoin },
];

export function isAdminNavActive(href: string, pathname: string): boolean {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(href + '/');
}
