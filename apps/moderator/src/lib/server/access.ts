import { error } from '@sveltejs/kit';
import type { SessionUser } from '@civitai/auth';
import { reportCountKey, reportEntities, reportEntityLabels, reportPath } from '$lib/reports';

export const APP = 'moderator';

export const ROLES = [
  'moderator:volunteer',
  'moderator:staff',
  'moderator:senior',
  'moderator:admin',
] as const;
export type Role = (typeof ROLES)[number];

// Reaches every page unconditionally and is never stored as a grant — otherwise revoking a page from admin
// would strand the only role that can grant it back.
const SUPER_ROLE: Role = 'moderator:admin';
export const GRANTABLE_ROLES: Role[] = ROLES.filter((r) => r !== SUPER_ROLE);

// Reachable by every authenticated moderator. The gate bounces a denied user here, so making it grantable
// would let an admin build an infinite redirect.
const UNRESTRICTED_PATHS = new Set(['/']);
// Reachable only by SUPER_ROLE, so the page that repairs a bad grant can't be granted away.
const SUPER_ONLY_PATHS = new Set(['/admin']);

export type NavLink = {
  label: string;
  path?: string;
  countKey?: string;
  external?: boolean;
  // Count is informational only — the dashboard keeps it out of "needs attention". For backlogs nobody
  // works through, like articles unpublished for spam.
  informational?: boolean;
  // The section is granted as one page and its children are neither granted nor checked individually. Making
  // these children grantable would drop the grants already stored against the parent path.
  sharedAccess?: boolean;
  children?: NavLink[];
};

export const NAVIGATION: NavLink[] = [
  { path: '/', label: 'Dashboard' },
  {
    label: 'Reports',
    path: '/reports',
    sharedAccess: true,
    children: reportEntities.map((entity) => ({
      path: reportPath(entity),
      label: reportEntityLabels[entity],
      countKey: reportCountKey(entity),
    })),
  },
  {
    label: 'Images',
    path: '/images',
    children: [
      { path: '/images/minor', label: 'Minor', countKey: 'minor' },
      { path: '/images/poi', label: 'POI', countKey: 'poi' },
      { path: '/images/tag', label: 'Blocked Tags', countKey: 'tag' },
      { path: '/images/newUser', label: 'New Users', countKey: 'newUser' },
      { path: '/images/modRule', label: 'Rule Violations', countKey: 'modRule' },
      { path: '/images/remixSource', label: 'Remix Source', countKey: 'remixSource' },
      { path: '/images/reported', label: 'Reported', countKey: 'reported' },
      { path: '/images/appeals', label: 'Appeals', countKey: 'appeals' },
      { path: '/images/csam', label: 'CSAM', countKey: 'csam' },
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
    children: [
      {
        path: '/articles/unpublished',
        label: 'Unpublished',
        countKey: 'articles',
        informational: true,
      },
      { path: '/articles/ratings', label: 'Rating Disputes', countKey: 'articleRatings' },
    ],
  },
  { path: '/cosmetics/grant', label: 'Grant Cosmetics' },
  {
    label: 'Audit',
    path: '/audit',
    children: [
      { path: '/audit/prohibited-prompts', label: 'Prohibited Prompts' },
      { path: '/audit/prompt-tester', label: 'Prompt Tester' },
      { path: '/audit/scanner-audit', label: 'Scanner Audit' },
    ],
  },
  {
    label: 'Retool',
    path: '/retool',
    children: [
      { path: '/retool/user-lookup', label: 'User Lookup' },
      { path: '/retool/image-lookup', label: 'Image Lookup' },
      { path: '/retool/article-lookup', label: 'Article Lookup' },
      { path: '/retool/user-reports', label: 'User Reports' },
      { path: '/retool/bulk-image-manager', label: 'Bulk Image Manager' },
      { path: '/retool/chat-audit', label: 'Chat Audit' },
      { path: '/retool/front-page-audit', label: 'Front Page Audit' },
      { path: '/retool/image-help', label: 'Image Help Requests' },
      { path: '/retool/queue-stats', label: 'Queue Stats' },
      { path: '/retool/bulk-ban', label: 'Bulk Ban' },
    ],
  },
  { path: '/comics-review', label: 'Comics Review' },
  { path: '/blocklists', label: 'Blocklists' },
  // One grant covers the whole lab. Its sub-pages (labels, runs, docs) resolve here by prefix rather than
  // being listed: they are steps of one loop, and granting a reviewer the queue but not the run history
  // would hide the numbers their review produces.
  { path: '/xguard', label: 'XGuard Lab' },
  { path: '/users', label: 'Users' },
  { path: '/admin', label: 'Permissions' },
  { path: '/page-visits', label: 'Page Usage' },
];

// App-global, not per-user, so sharing module state across concurrent requests is safe.
let stored: Partial<Record<string, Role[]>> = {};

export function applyGrants(map: Record<string, string[]>): void {
  const next: Partial<Record<string, Role[]>> = {};
  for (const [path, roles] of Object.entries(map)) {
    if (isGrantable(path)) next[path] = roles.filter(isGrantableRole);
  }
  if (sameGrants(next, stored)) return;
  stored = next;
  grants = collectGrants(NAVIGATION);
}

function sameGrants(a: Partial<Record<string, Role[]>>, b: Partial<Record<string, Role[]>>) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => {
    const x = a[k];
    const y = b[k];
    return x && y && x.length === y.length && x.every((r) => y.includes(r));
  });
}

// A group's roles are the union of its own grant and its children's, so granting one queue also opens the
// section that lists it. Leaves have no children, so their set is just what was granted.
function collectGrants(
  links: NavLink[],
  acc: { path: string; roles: Set<Role> }[] = []
): { path: string; roles: Set<Role> }[] {
  for (const link of links) {
    const own = link.path ? stored[link.path] ?? [] : [];
    if (link.sharedAccess) {
      if (link.path) acc.push({ path: link.path, roles: new Set(own) });
      continue;
    }
    const before = acc.length;
    if (link.children) collectGrants(link.children, acc);
    const fromChildren = acc.slice(before).flatMap((entry) => [...entry.roles]);
    if (link.path && !link.external)
      acc.push({ path: link.path, roles: new Set([...own, ...fromChildren]) });
  }
  return acc;
}
let grants = collectGrants(NAVIGATION);

/** The effective path→roles map `allows` consults, for diagnostics — group entries included. */
export function grantsSnapshot(): Record<string, Role[]> {
  return Object.fromEntries(grants.map((g) => [g.path, [...g.roles]]));
}

type RoleUser = Pick<SessionUser, 'roles'> | null | undefined;

const isSuper = (user: RoleUser) => (user?.roles ?? []).includes(SUPER_ROLE);

function allows(path: string, user: RoleUser): boolean {
  if (isSuper(user)) return true;
  if (UNRESTRICTED_PATHS.has(path)) return true;
  if (SUPER_ONLY_PATHS.has(path)) return false;
  const match = grants.find((g) => g.path === path);
  return !!match && (user?.roles ?? []).some((r) => match.roles.has(r as Role));
}

function pruneNav(links: NavLink[], user: RoleUser): NavLink[] {
  const out: NavLink[] = [];
  for (const link of links) {
    if (link.path && !allows(link.path, user)) continue;
    if (link.sharedAccess) {
      out.push({ ...link });
      continue;
    }
    const children = link.children ? pruneNav(link.children, user) : undefined;
    if (link.children && (!children || children.length === 0)) continue;
    out.push({ ...link, children });
  }
  return out;
}

// Display order for top-level entries — the sidebar and the permissions checklist both sort by this so the
// two always read the same. Gating is unaffected; it matches on paths.
const NAV_PINNED_FRONT = new Set(['/', '/reports']);
const navBand = (link: NavLink): number =>
  link.path && NAV_PINNED_FRONT.has(link.path) ? 0 : link.children ? 1 : 2;
const byNavOrder = (a: NavLink, b: NavLink) => navBand(a) - navBand(b);

export function navForUser(user: RoleUser): NavLink[] {
  return pruneNav(NAVIGATION, user).sort(byNavOrder);
}

// Longest-matching path wins, so a sub-path resolves to the nav entry that owns it; unmatched = denied.
/**
 * A capability restricted to senior moderators, independent of which pages a role can reach. Retool
 * expressed these as `current_user.groups.some(i => i.name === "Senior Mod")` on a pane — a condition
 * that appears in no query, so porting the pane without it silently widens the capability. Buzz
 * sending is the one this was found on.
 */
export function isSenior(user: RoleUser): boolean {
  const roles = user?.roles ?? [];
  return roles.includes('moderator:senior') || roles.includes(SUPER_ROLE);
}

export function canAccess(user: RoleUser, pathname: string): boolean {
  const matches = grants.filter((g) => pathname === g.path || pathname.startsWith(`${g.path}/`));
  if (!matches.length) return false;
  const best = matches.reduce((a, b) => (b.path.length > a.path.length ? b : a));
  return allows(best.path, user);
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
  return group.sharedAccess ? group.children : pruneNav(group.children, user);
}

// `group` rows are section headers, not pages — they carry no checkbox because their reachability is the
// union of their children.
export type PageEntry = { path: string; label: string; depth: number; group: boolean };

// The admin page's editing surface: only pages a role can actually be granted, with only the roles that
// can hold a grant. What isn't stored isn't checked — there are no implied grants to display.
// `source` lets the admin page pass grants read straight from Postgres; omitting it falls back to the
// request cache, which is fine for read-only callers but never for the editing surface.
export function pageAccessState(source?: Record<string, string[]>): {
  pages: PageEntry[];
  granted: Record<string, Role[]>;
} {
  const from = source
    ? Object.fromEntries(Object.entries(source).map(([p, r]) => [p, r.filter(isGrantableRole)]))
    : stored;
  const pages: PageEntry[] = [];
  const granted: Record<string, Role[]> = {};
  const walk = (links: NavLink[], depth: number) => {
    for (const link of links) {
      const group = !!link.children && !link.sharedAccess;
      if (link.path && !link.external && (group || isGrantable(link.path))) {
        pages.push({ path: link.path, label: link.label, depth, group });
        if (!group) granted[link.path] = from[link.path] ?? [];
      }
      if (link.children && !link.sharedAccess) walk(link.children, depth + 1);
    }
  };
  walk([...NAVIGATION].sort(byNavOrder), 0);
  return { pages, granted };
}

// A link with children is a section, and a section is reachable exactly when one of its pages is — there
// is nothing separate to grant.
export function isGrantable(path: string): boolean {
  if (UNRESTRICTED_PATHS.has(path) || SUPER_ONLY_PATHS.has(path)) return false;
  const item = findNavItem(path);
  return !!item && (!item.children || !!item.sharedAccess);
}

export function isNavPath(path: string): boolean {
  return findNavItem(path) !== undefined;
}

export function isGrantableRole(value: string): value is Role {
  return (GRANTABLE_ROLES as string[]).includes(value);
}
