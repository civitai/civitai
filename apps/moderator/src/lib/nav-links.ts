import type { NavLink } from '$lib/server/access';

export const isPathActive = (href: string, path: string) =>
  href === '/' ? path === '/' : path === href || path.startsWith(href + '/');

/** Active on its own path, unless a sibling with a longer path also matches (`/users` vs `/users/newest`). */
export function isNavLinkActive(link: NavLink, siblings: NavLink[], url: URL): boolean {
  if (link.external || !link.path || !isPathActive(link.path, url.pathname)) return false;
  return !siblings.some(
    (other) =>
      !other.external &&
      other.path &&
      other.path.length > link.path!.length &&
      isPathActive(other.path, url.pathname)
  );
}
