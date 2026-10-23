import type { NavLink } from '$lib/server/access';

export const isPathActive = (href: string, path: string) =>
  href === '/' ? path === '/' : path === href || path.startsWith(href + '/');

/**
 * A link's path matches, and so does every query param it carries — a link to a filtered view
 * (`/feedback?area=…`) is active only while that filter is.
 */
function linkMatches(link: NavLink, url: URL): boolean {
  if (link.external || !link.path) return false;
  const [path, query = ''] = link.path.split('?');
  if (!isPathActive(path, url.pathname)) return false;
  return [...new URLSearchParams(query)].every(([key, value]) =>
    url.searchParams.getAll(key).includes(value)
  );
}

/**
 * Active on its own path, unless a sibling with a longer path also matches (`/users` vs
 * `/users/newest`, or `/feedback` vs `/feedback?area=…`).
 */
export function isNavLinkActive(link: NavLink, siblings: NavLink[], url: URL): boolean {
  if (!linkMatches(link, url)) return false;
  return !siblings.some(
    (other) => !!other.path && other.path.length > link.path!.length && linkMatches(other, url)
  );
}

/** A `tabs` group is one sidebar entry; it opens on the first tab the user holds (`children` arrive pruned). */
export const navHref = (link: NavLink): string | undefined =>
  link.tabs ? link.children?.[0]?.path ?? link.path : link.path;

/**
 * The badge for a link: its own count, or for a group the sum of its non-informational children. Null
 * while nothing it sums has loaded.
 */
export function navCount(
  link: NavLink,
  countFor: (key: string | undefined) => number | null
): number | null {
  if (!link.children) return countFor(link.countKey);
  let total: number | null = null;
  for (const child of link.children) {
    if (child.informational) continue;
    const count = navCount(child, countFor);
    if (count !== null) total = (total ?? 0) + count;
  }
  return total;
}

/** Whether a link's badge leaves out a count that could not be read: it, or a child it sums. */
export function navPartial(link: NavLink, isUnavailable: (key: string) => boolean): boolean {
  if (!link.children) return !!link.countKey && isUnavailable(link.countKey);
  return link.children.some((child) => !child.informational && navPartial(child, isUnavailable));
}

export type SwitcherEntry = { label: string; href: string; external: boolean };

/** Every page the sidebar can open, as "Group › Page"; a `tabs` group is one entry, as in the sidebar. */
export function switcherEntries(
  nav: NavLink[],
  civitaiUrl: string,
  trail: string[] = []
): SwitcherEntry[] {
  return nav.flatMap((link) => {
    if (link.children && !link.tabs) {
      return switcherEntries(link.children, civitaiUrl, [...trail, link.label]);
    }
    const href = navHref(link);
    if (!href) return [];
    const external = !!link.external;
    return [
      {
        label: [...trail, link.label].join(' › '),
        href: external ? `${civitaiUrl}${href}` : href,
        external,
      },
    ];
  });
}
