import { error } from '@sveltejs/kit';
import type { SessionUser } from '@civitai/auth';

export const APP = 'moderator';

// Lowest privilege first — the numeric rank IS the privilege order; gating is `rank >= required`.
const ROLE_RANK = {
  'moderator:volunteer': 0,
  'moderator:staff': 1,
  'moderator:senior': 2,
  'moderator:admin': 3,
} as const;
export type Role = keyof typeof ROLE_RANK;

// `role` = minimum tier to see + access; children inherit their parent's role unless they raise it.
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
    label: 'Audit',
    path: '/audit',
    role: 'moderator:staff',
    children: [
      { path: '/audit/prohibited-prompts', label: 'Prohibited Prompts' },
      { path: '/audit/prompt-tester', label: 'Prompt Tester' },
      { path: '/audit/scanner-audit', label: 'Scanner Audit' },
    ],
  },
  { path: '/comics-review', label: 'Comics Review', role: 'moderator:staff' },
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

// Reorders only the rendered sidebar; gating (collectPathRanks) still reads NAVIGATION in source order.
const NAV_PINNED_FRONT = new Set(['/', '/reports']);
const navBand = (link: NavLink): number =>
  link.path && NAV_PINNED_FRONT.has(link.path) ? 0 : link.children ? 1 : 2;

export function navForUser(user: RoleUser): NavLink[] {
  return pruneNav(NAVIGATION, userRank(user)).sort((a, b) => navBand(a) - navBand(b));
}

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

// Longest-matching path wins (a senior child under a staff prefix stays senior); unmatched = denied.
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

export function navLabel(pathname: string): string | undefined {
  return findNavItem(pathname)?.label;
}

export function childLinks(groupPath: string, user: RoleUser): NavLink[] {
  const group = findNavItem(groupPath);
  if (!group?.children) return [];
  return pruneNav(group.children, userRank(user), rankOf(group.role, -1));
}

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
