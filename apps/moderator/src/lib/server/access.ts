import { error, fail, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '@civitai/auth';
import { reportCountKey, reportEntities, reportEntityLabels, reportPath } from '$lib/reports';

export const APP = 'moderator';

/**
 * A role id as the auth hub issues them (`app:slug`). Deliberately not a closed union: the hub's `Role`
 * table is the catalogue, and a list kept here left a role created there invisible on `/admin` — with no
 * error to notice, since every other screen reads roles off the session as opaque strings.
 * `$lib/server/roles.ts` reads the live set.
 */
export type Role = string;

// Reaches every page unconditionally and is never stored as a grant — otherwise revoking a page from admin
// would strand the only role that can grant it back.
export const SUPER_ROLE: Role = 'moderator:admin';

export const isStorableRole = (value: string): boolean => value !== SUPER_ROLE;

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

// Permission declarations live in `$lib/permissions.ts` — components need the labels and refusal
// wording too, and a server-only home is what let the client re-type them and drift. Re-exported so the
// gate and the declarations still read as one API at the call sites.
import {
  denied,
  PERMISSIONS,
  permissionByKey,
  type PermissionId,
  type PermissionSet,
  permissionKey,
  isPermissionKey,
} from '$lib/permissions';

export { PERMISSIONS, permissionKey, denied, type Permission } from '$lib/permissions';

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
      // `informational`: the page has no actions — the count is upload throughput, and the whole
      // backlog whenever the scanner stalls. Summed into the group badge it reads as a review backlog.
      {
        path: '/images/to-ingest',
        label: 'Images to Ingest',
        countKey: 'toIngest',
        informational: true,
      },
      { path: '/images/ingestion-errors', label: 'Ingestion Errors', countKey: 'ingestionErrors' },
    ],
  },
  // Models gets its own group beside Images and Articles rather than a single top-level entry — the
  // model-side queues are a section, not a page, and the next one added should have somewhere to go.
  {
    label: 'Models',
    path: '/models',
    children: [
      // No `countKey`: the Pending count costs ~10s, and `sidebar-counts.service.ts` is one Promise.all
      // that every navigation in the app waits on. The counts live on the page's own tabs instead,
      // fetched separately. A countKey nothing produces renders as a silently missing badge.
      { path: '/models/minor-hash-matches', label: 'Minor Hash Matches' },
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
      { path: '/audit/generator-restrictions', label: 'Generator Restrictions' },
      { path: '/audit/training-models', label: 'Training Models' },
      { path: '/audit/training-data', label: 'Training Data Review' },
    ],
  },
  {
    label: 'Retool',
    path: '/retool',
    children: [
      {
        path: '/retool/user-lookup',
        label: 'User Lookup',
      },
      { path: '/retool/image-lookup', label: 'Image Lookup' },
      { path: '/retool/article-lookup', label: 'Article Lookup' },
      { path: '/retool/user-reports', label: 'User Reports' },
      { path: '/retool/post-reports', label: 'Post Reports' },
      { path: '/retool/bulk-image-manager', label: 'Bulk Image Manager' },
      { path: '/retool/chat-audit', label: 'Chat Audit' },
      { path: '/retool/front-page-audit', label: 'Front Page Audit' },
      { path: '/retool/image-help', label: 'Image Help Requests' },
      { path: '/retool/queue-stats', label: 'Queue Stats' },
      { path: '/retool/takedown-hashes', label: 'Takedown Hashes' },
      {
        path: '/retool/bulk-ban',
        label: 'Bulk Ban',
        // Reaching the page is an investigation — the candidate list, the IP clustering. Running the
        // ban is the highest-blast-radius action in the app and stays separate from reading it.
      },
    ],
  },
  { path: '/comics-review', label: 'Comics Review' },
  // One grant covers the section. Its detail view (`/abuse/<runId>`) resolves here by prefix rather
  // than being listed: a run and its findings are one thing, and granting the list without the rows
  // would show a moderator a count they cannot open.
  { path: '/abuse', label: 'Abuse Detection' },
  { path: '/blocklists', label: 'Blocklists' },
  // One grant covers the whole lab. Its sub-pages (labels, runs, docs) resolve here by prefix rather than
  // being listed: they are steps of one loop, and granting a reviewer the queue but not the run history
  // would hide the numbers their review produces.
  { path: '/xguard', label: 'XGuard Lab' },
  { path: '/users', label: 'Users' },
  { path: '/admin', label: 'Permissions' },
  { path: '/page-visits', label: 'Page Usage' },
];

// App-global, not per-user, so sharing module state across concurrent requests is safe. Capabilities are held
// apart from pages rather than filtered out at every read: `grants` drives route gating, and a key that
// can never be a route has no business in it.
let stored: Partial<Record<string, Role[]>> = {};
let storedPermissions: Partial<Record<string, Role[]>> = {};

export function applyGrants(map: Record<string, string[]>): void {
  const nextPages: Partial<Record<string, Role[]>> = {};
  const nextPermissions: Partial<Record<string, Role[]>> = {};
  // Checked against the super role only, never the hub's role catalogue: this runs on every gated request,
  // and a grant filtered against a catalogue that failed to load would revoke the app. A grant naming a
  // role nobody holds — a deleted one — matches nobody anyway.
  for (const [key, roles] of Object.entries(map)) {
    const allowed = roles.filter(isStorableRole);
    if (isPermissionKey(key)) {
      if (isGrantablePermission(key)) nextPermissions[key] = allowed;
    } else if (isGrantable(key)) nextPages[key] = allowed;
  }
  if (sameGrants(nextPages, stored) && sameGrants(nextPermissions, storedPermissions)) return;
  stored = nextPages;
  storedPermissions = nextPermissions;
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
  return !!match && (user?.roles ?? []).some((r) => match.roles.has(r));
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

/**
 * What this user holds, resolved once so both sides read the same answer. Granted permissions only —
 * see `PermissionSet`.
 *
 * 🔴 Call this AFTER `applyGrants`. Before it the store is empty and everyone resolves to `{}` — safe,
 * since an absent key reads false everywhere, but silently.
 *
 * The super role is MATERIALISED rather than short-circuited, so the record that reaches the client
 * shows an admin exactly what the server would let them do.
 */
export function resolvePermissions(user: RoleUser): PermissionSet {
  const out: PermissionSet = {};
  const roles = user?.roles ?? [];
  const superUser = isSuper(user);
  for (const permission of PERMISSIONS) {
    const granted = storedPermissions[permissionKey(permission.id)] ?? [];
    if (superUser || roles.some((r) => granted.includes(r))) out[permission.id] = true;
  }
  return out;
}

/** The effective feature→roles map, for diagnostics. Pair with `grantsSnapshot`. */
export function permissionGrantsSnapshot(): Record<string, Role[]> {
  return Object.fromEntries(
    PERMISSIONS.map((p) => permissionKey(p.id)).map((key) => [
      key,
      [...(storedPermissions[key] ?? [])],
    ])
  );
}

// Longest-matching path wins, so a sub-path resolves to the nav entry that owns it; unmatched = denied.
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

/**
 * One row of the `/admin` tree. `group` rows are section headers and store nothing of their own — their
 * reachability is the union of their children — but they still carry a key so the UI can address the
 * subtree they head. `feature` rows are grantable only while their `parent` page is.
 */
export type AccessNode = {
  key: string;
  label: string;
  kind: 'group' | 'page' | 'permission';
  children: AccessNode[];
};

// The admin page's editing surface: only what a role can actually be granted, with only the roles that
// can hold a grant. What isn't stored isn't checked — there are no implied grants to display.
//
// `edit` is the editing surface's inputs: grants read straight from Postgres (the request cache is fine
// for read-only callers, never for editing) and the hub's live role catalogue, which narrows the stored
// roles so a role retired there stops being carried forward by the next save. One argument rather than
// two optional ones because the two must arrive together — filtering fresh grants against a stale role
// list, or vice versa, silently reverts to the behaviour this replaced.
export function pageAccessState(edit?: {
  grants: Record<string, string[]>;
  roles: readonly Role[];
}): {
  tree: AccessNode[];
  /**
   * Action grants, FLAT and beside the page tree rather than under it. A permission is granted on its
   * own — nesting it under a page is what let an ungranted page revoke it, and made a permission
   * surfaced on two pages inexpressible.
   */
  actions: AccessNode[];
  granted: Record<string, Role[]>;
  /** Every routable path in the tree, groups included — what `whoami` reports verdicts for. */
  paths: string[];
} {
  const from = edit
    ? Object.fromEntries(
        Object.entries(edit.grants).map(([p, r]) => [
          p,
          r.filter((role) => edit.roles.includes(role)),
        ])
      )
    : { ...stored, ...storedPermissions };
  const granted: Record<string, Role[]> = {};
  const paths: string[] = [];

  const walk = (links: NavLink[]): AccessNode[] => {
    const out: AccessNode[] = [];
    for (const link of links) {
      const group = !!link.children && !link.sharedAccess;
      const children = link.children && !link.sharedAccess ? walk(link.children) : [];
      if (!link.path || link.external) {
        out.push(...children);
        continue;
      }
      if (group) {
        // A section whose every child is ungrantable would render as an empty header with a checkbox
        // that addresses nothing. It is still a real route, so it is still reported in `paths`.
        paths.push(link.path);
        if (children.length)
          out.push({ key: link.path, label: link.label, kind: 'group', children });
        continue;
      }
      const path = link.path;
      paths.push(path);
      if (!isGrantable(path)) continue;
      granted[path] = from[path] ?? [];
      out.push({ key: path, label: link.label, kind: 'page', children: [] });
    }
    return out;
  };

  const actions = PERMISSIONS.map((permission): AccessNode => {
    const key = permissionKey(permission.id);
    granted[key] = from[key] ?? [];
    return { key, label: permission.label, kind: 'permission', children: [] };
  });

  return { tree: walk([...NAVIGATION].sort(byNavOrder)), actions, granted, paths };
}

/** A permission is grantable exactly when it is declared and the page it sits under is itself grantable. */
export function isGrantablePermission(key: string): boolean {
  return !!permissionByKey(key);
}

// A link with children is a section, and a section is reachable exactly when one of its pages is — there
// is nothing separate to grant.
export function isGrantable(path: string): boolean {
  if (UNRESTRICTED_PATHS.has(path) || SUPER_ONLY_PATHS.has(path)) return false;
  const item = findNavItem(path);
  return !!item && (!item.children || !!item.sharedAccess);
}

/**
 * Gates a form action on a grant, so the permission is part of the action's signature rather than a
 * line someone can forget to write — a missing guard is invisible in review, a missing wrapper is not.
 *
 * Returns `fail`, never `throw error()`: throwing renders the nearest error boundary, which unmounts
 * the page and takes the operator's in-progress edits with it.
 */
export function requiresGrant<E extends RequestEvent, R>(
  id: PermissionId,
  handler: (event: E) => R
) {
  return (event: E): R | ActionFailure<{ scope: 'denied'; error: string }> =>
    event.locals.grants[id]
      ? handler(event)
      : fail(403, { scope: 'denied' as const, error: denied(id) });
}
