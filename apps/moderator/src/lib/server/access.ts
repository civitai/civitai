import { error } from '@sveltejs/kit';
import type { SessionUser } from '@civitai/auth';

export const APP = 'moderator';

export type NavLink = { path: string; label: string };

// Moderator roles, lowest privilege first. Each tier ADDS its pages; a user inherits every tier at or below
// their highest role (admin ⊇ senior ⊇ staff ⊇ volunteer). Pages under the admin tier are admin-only.
export const ROLE_HIERARCHY: { role: string; navigation: NavLink[] }[] = [
  { role: 'moderator:volunteer', navigation: [{ path: '/reports', label: 'Reports' }] },
  {
    role: 'moderator:staff',
    navigation: [
      { path: '/images', label: 'Images' },
      { path: '/images/to-ingest', label: 'Images to Ingest' },
      { path: '/ingestion-error-review', label: 'Ingestion Errors' },
      { path: '/articles', label: 'Articles' },
      { path: '/article-rating-review', label: 'Article Ratings' },
      { path: '/cosmetics/grant', label: 'Grant Cosmetics' },
      { path: '/scanner-audit', label: 'Scanner Audit' },
      { path: '/blocklists', label: 'Blocklists' },
    ],
  },
  { role: 'moderator:senior', navigation: [{ path: '/users', label: 'Users' }] },
  {
    role: 'moderator:admin',
    navigation: [
      { path: '/admin', label: 'Permissions' },
      { path: '/page-visits', label: 'Page Usage' },
    ],
  },
];

const BASE_NAVIGATION: NavLink[] = [{ path: '/', label: 'Dashboard' }];

export type NavGroup = { role: string | null; links: NavLink[] };

type RoleUser = Pick<SessionUser, 'roles'> | null | undefined;

// Index of the highest tier the user holds (-1 if none); they inherit every tier up to and including it.
function userRank(user: RoleUser): number {
  const roles = new Set(user?.roles ?? []);
  let rank = -1;
  ROLE_HIERARCHY.forEach((tier, i) => {
    if (roles.has(tier.role)) rank = i;
  });
  return rank;
}

export function navGroupsForUser(user: RoleUser): NavGroup[] {
  const rank = userRank(user);
  const groups: NavGroup[] = [{ role: null, links: BASE_NAVIGATION }];
  for (let i = 0; i <= rank; i++) {
    const tier = ROLE_HIERARCHY[i];
    if (tier.navigation.length) groups.push({ role: tier.role, links: tier.navigation });
  }
  return groups;
}

export function navForUser(user: RoleUser): NavLink[] {
  return navGroupsForUser(user).flatMap((g) => g.links);
}

export function canAccess(user: RoleUser, pathname: string): boolean {
  return navForUser(user).some((l) => pathname === l.path || pathname.startsWith(`${l.path}/`));
}

export function requireAccess(user: RoleUser, pathname: string): void {
  if (!canAccess(user, pathname)) error(403, 'You do not have access to this page.');
}
