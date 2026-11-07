import type { ComponentProps } from 'svelte';
import type Icon from './Icon.svelte';

type IconName = ComponentProps<typeof Icon>['name'];

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** Other paths that belong to this tab: pages reached from it that have no tab of their own. */
  also?: readonly string[];
};

/** The primary navigation, in tab order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/home', label: 'Home', icon: 'house', also: ['/judgments', '/leaderboard'] },
  { href: '/play', label: 'Judge', icon: 'gavel' },
  { href: '/codex', label: 'Codex', icon: 'book-open' },
  { href: '/shop', label: 'Shop', icon: 'coins' },
];

const under = (root: string, pathname: string) =>
  pathname === root || pathname.startsWith(`${root}/`);

/** The tab a path belongs to, or null on a page with no tab (the dev tools, for one). */
export function activeHref(pathname: string, items: readonly NavItem[] = NAV_ITEMS): string | null {
  return (
    items.find((item) => [item.href, ...(item.also ?? [])].some((root) => under(root, pathname)))
      ?.href ?? null
  );
}
