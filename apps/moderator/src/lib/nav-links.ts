import type { NavLink } from '$lib/server/access';

export const navHref = (link: NavLink) => (link.query ? `${link.path}?${link.query}` : link.path);

export const isPathActive = (href: string, path: string) =>
  href === '/' ? path === '/' : path === href || path.startsWith(href + '/');

const queryMatches = (query: string, url: URL) =>
  [...new URLSearchParams(query)].every(([key, value]) => url.searchParams.get(key) === value);

/** A view link is active while its query is on the URL; the page it filters is active otherwise. */
export function isNavLinkActive(link: NavLink, siblings: NavLink[], url: URL): boolean {
  if (link.external || !link.path || !isPathActive(link.path, url.pathname)) return false;
  if (link.query) return queryMatches(link.query, url);
  return !siblings.some(
    (other) => other.query && other.path === link.path && queryMatches(other.query, url)
  );
}
