import { error } from '@sveltejs/kit';
import type { SessionUser } from '@civitai/auth';

export const APP = 'moderator';

// Moderator role tiers, lowest privilege first. A user's rank is the highest tier they hold; access +
// visibility require rank >= the item's required rank (holding `staff` implies `volunteer` etc.).
const ROLE_RANK = {
  'moderator:volunteer': 0,
  'moderator:staff': 1,
  'moderator:senior': 2,
  'moderator:admin': 3,
} as const;
export type Role = keyof typeof ROLE_RANK;

// One unified nav tree (NOT split into role sections). `role` = the minimum tier to SEE + ACCESS this
// item; children inherit their parent's role unless they raise it (e.g. a senior child under the staff
// Images group). `external` links out to the main app. `countKey` indexes the sidebar counts map.
export type NavLink = {
  label: string;
  path?: string;
  role?: Role;
  countKey?: string;
  external?: boolean;
  children?: NavLink[];
};

export const NAVIGATION: NavLink[] = [
  { path: '/', label: 'Dashboard' },
  { path: '/reports', label: 'Reports', role: 'moderator:volunteer' },
  {
    // The /images review queue — its modes are the sub-nav, each its own /images/<mode> route (handled by
    // the [slug] page). `path: '/images'` gates the staff subtree; senior-only children (CSAM, and later
    // Appeals) raise their own role, and longest-prefix gating in canAccess honors that.
    label: 'Images',
    path: '/images',
    role: 'moderator:staff',
    children: [
      { path: '/images/minor', label: 'Minor', countKey: 'minor' },
      { path: '/images/poi', label: 'POI', countKey: 'poi' },
      { path: '/images/tag', label: 'Blocked Tags', countKey: 'tag' },
      { path: '/images/newUser', label: 'New Users', countKey: 'newUser' },
      { path: '/images/modRule', label: 'Rule Violations', countKey: 'modRule' },
      { path: '/images/remixSource', label: 'Remix Source', countKey: 'remixSource' },
      { path: '/images/reported', label: 'Reported', countKey: 'reported' },
      { path: '/images/appeals', label: 'Appeals', role: 'moderator:senior', countKey: 'appeals' },
      { path: '/images/csam', label: 'CSAM', role: 'moderator:senior', countKey: 'csam' },
      { path: '/images/tags', label: 'Image Tags', countKey: 'imageTags' },
      { path: '/images/ratings', label: 'Image Ratings', countKey: 'imageRatings' },
      { path: '/images/downleveled', label: 'Downleveled' },
      { path: '/images/to-ingest', label: 'Images to Ingest' },
      { path: '/images/ingestion-errors', label: 'Ingestion Errors' },
    ],
  },
  {
    // Articles review area — the moderation list + rating disputes, grouped like Images. `path: '/articles'`
    // gates the staff subtree + gives the group its icon; the list itself is the first child (a group
    // header is a collapse toggle, not a link, so the index page needs its own child entry).
    label: 'Articles',
    path: '/articles',
    role: 'moderator:staff',
    children: [
      { path: '/articles/unpublished', label: 'Unpublished', countKey: 'articles' },
      { path: '/articles/ratings', label: 'Rating Disputes', countKey: 'articleRatings' },
    ],
  },
  { path: '/cosmetics/grant', label: 'Grant Cosmetics', role: 'moderator:staff' },
  {
    // Audit tools grouped under /audit: the prohibited-prompts monitor, the prompt tester, and scanner
    // audit (which keeps its own [mode]/[label] subtree). `path: '/audit'` gates the subtree + gives the
    // group its icon; the bare path redirects to the monitor (a group header is a toggle, not a link).
    label: 'Audit',
    path: '/audit',
    role: 'moderator:staff',
    children: [
      { path: '/audit/prohibited-prompts', label: 'Prohibited Prompts' },
      { path: '/audit/prompt-tester', label: 'Prompt Tester' },
      { path: '/audit/scanner-audit', label: 'Scanner Audit' },
    ],
  },
  { path: '/blocklists', label: 'Blocklists', role: 'moderator:staff' },
  { path: '/users', label: 'Users', role: 'moderator:senior' },
  { path: '/admin', label: 'Permissions', role: 'moderator:admin' },
  { path: '/page-visits', label: 'Page Usage', role: 'moderator:admin' },
];

type RoleUser = Pick<SessionUser, 'roles'> | null | undefined;

// Highest tier the user holds (-1 = none; base/no-role items are still visible at -1).
function userRank(user: RoleUser): number {
  return Math.max(-1, ...(user?.roles ?? []).map((r) => ROLE_RANK[r as Role] ?? -1));
}

const rankOf = (role: Role | undefined, inherited: number) =>
  role !== undefined ? ROLE_RANK[role] : inherited;

// Prune the tree to what `user` may see: drop items above their rank, recurse children with the item's
// (inherited) rank, and drop a group left with no visible children.
function pruneNav(links: NavLink[], rank: number, inherited = -1): NavLink[] {
  const out: NavLink[] = [];
  for (const link of links) {
    const required = rankOf(link.role, inherited);
    if (rank < required) continue;
    const children = link.children ? pruneNav(link.children, rank, required) : undefined;
    if (link.children && (!children || children.length === 0)) continue;
    out.push({ ...link, children });
  }
  return out;
}

// Sidebar display order: Dashboard + Reports pinned at the top, then groups (items with children), then
// the remaining childless items. Stable within each band, so NAVIGATION source order breaks ties. This
// only reorders the rendered sidebar — gating (collectPathRanks) and roleHierarchy still read NAVIGATION
// in source order.
const NAV_PINNED_FRONT = new Set(['/', '/reports']);
const navBand = (link: NavLink): number =>
  link.path && NAV_PINNED_FRONT.has(link.path) ? 0 : link.children ? 1 : 2;

export function navForUser(user: RoleUser): NavLink[] {
  return pruneNav(NAVIGATION, userRank(user)).sort((a, b) => navBand(a) - navBand(b));
}

// Flat (path, requiredRank) for every INTERNAL path in the full tree — the gating source of truth.
function collectPathRanks(
  links: NavLink[],
  inherited = -1,
  acc: { path: string; rank: number }[] = []
): { path: string; rank: number }[] {
  for (const link of links) {
    const required = rankOf(link.role, inherited);
    if (link.path && !link.external) acc.push({ path: link.path, rank: required });
    if (link.children) collectPathRanks(link.children, required, acc);
  }
  return acc;
}
const PATH_RANKS = collectPathRanks(NAVIGATION);

// Longest-matching path wins, so a senior child (/images/appeals) still requires senior even though the
// staff /images prefix also matches. Unmatched paths are denied.
export function canAccess(user: RoleUser, pathname: string): boolean {
  const matches = PATH_RANKS.filter(
    (pr) => pathname === pr.path || pathname.startsWith(`${pr.path}/`)
  );
  if (!matches.length) return false;
  const best = matches.reduce((a, b) => (b.path.length > a.path.length ? b : a));
  return userRank(user) >= best.rank;
}

export function requireAccess(user: RoleUser, pathname: string): void {
  if (!canAccess(user, pathname)) error(403, 'You do not have access to this page.');
}

function findNavItem(pathname: string, links: NavLink[] = NAVIGATION): NavLink | undefined {
  for (const link of links) {
    if (link.path === pathname) return link;
    if (link.children) {
      const found = findNavItem(pathname, link.children);
      if (found) return found;
    }
  }
  return undefined;
}

// NAVIGATION is the single source of page labels — a page reads its own title from here (via server
// props) rather than re-declaring it.
export function navLabel(pathname: string): string | undefined {
  return findNavItem(pathname)?.label;
}

// The accessible children of the group at `groupPath` for `user` (role-pruned, inheriting the group's
// role). Used by the /images hub page to list its sub-pages.
export function childLinks(groupPath: string, user: RoleUser): NavLink[] {
  const group = findNavItem(groupPath);
  if (!group?.children) return [];
  return pruneNav(group.children, userRank(user), rankOf(group.role, -1));
}

// Role → pages view for the admin transparency page. Top-level items grouped by their required tier, plus
// any child that RAISES the role (e.g. senior CSAM under the staff Images group); same-tier children (the
// image modes) are represented by their group entry.
export function roleHierarchy(): { role: Role; navigation: { path: string; label: string }[] }[] {
  const byRank = new Map<number, { path: string; label: string }[]>();
  const push = (rank: number, link: NavLink) => {
    if (!link.path) return;
    byRank.set(rank, [...(byRank.get(rank) ?? []), { path: link.path, label: link.label }]);
  };
  for (const link of NAVIGATION) {
    const rank = rankOf(link.role, -1);
    push(rank, link);
    for (const child of link.children ?? []) {
      if (child.role !== undefined && ROLE_RANK[child.role] !== rank)
        push(ROLE_RANK[child.role], child);
    }
  }
  return (Object.keys(ROLE_RANK) as Role[]).map((role) => ({
    role,
    navigation: byRank.get(ROLE_RANK[role]) ?? [],
  }));
}
