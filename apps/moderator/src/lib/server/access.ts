import { error, fail, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '@civitai/auth';
import { APPS_PLATFORM_FEEDBACK_AREA } from '@civitai/shared/feedback.constants';
import { GENERATOR_RESTRICTIONS_PATH, SCAM_RESTRICTIONS_PATH } from '$lib/restriction-types';
import {
  MODEL_FLAGS_APPEALS_PATH,
  MODEL_FLAGS_AUTO_PATH,
  MODEL_FLAGS_NEEDS_REVIEW_PATH,
  MODEL_FLAGS_PATH,
} from '$lib/minor-flags/paths';
import { MODEL_RULE_MATCHES_PATH } from '$lib/model-rule-holds';
import { needsReviewCountKey, needsReviewSources } from '$lib/minor-flags/needs-review';
import { reportCountKey, reportEntities, reportEntityLabels, reportPath } from '$lib/reports';
import { SITE_APPEAL_QUEUES, siteAppealCountKey, siteAppealQueuePath } from '$lib/site-appeals';

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

// The hub's catalogue for this app is exactly its prefix (`listAppRoles`), so a stored role carrying the
// prefix but missing from the catalogue is retired. A role without it belongs to another system (a service
// account's) and is never this app's to remove.
export const isAppRole = (value: string): boolean => value.startsWith(`${APP}:`);

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
  // Count is informational only — kept out of the dashboard's "needs attention" total and the sidebar
  // group badge. For counts nobody works through: spam-unpublished articles, stuck scans.
  informational?: boolean;
  // The section is granted as one page and its children are neither granted nor checked individually. Making
  // these children grantable would drop the grants already stored against the parent path.
  sharedAccess?: boolean;
  // Hover-preloading runs the page's `load`; for a page whose load takes a lease, that is a write.
  noPreload?: boolean;
  // The children are grant-aware tab routes of one page: still granted one by one (and listed on /admin), but
  // the sidebar renders the group as a single entry and the page draws its own tab bar.
  tabs?: true;
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
      { path: '/images/appeals', label: 'Appeals', countKey: 'appeals' },
      {
        path: '/images/removed-appeals',
        label: 'Appeals: Content Removed',
        countKey: 'removedAppeals',
      },
      { path: '/images/re-removals', label: 'Re-removals', countKey: 'reRemovals' },
      { path: '/images/csam', label: 'CSAM', countKey: 'csam' },
      // Linked from the expiry alert email, which never names the policy: keep it out of /csam.
      { path: '/evidence-holds', label: 'Evidence Holds', countKey: 'evidenceHoldsEnding' },
      { path: '/images/scan-labels', label: 'Scan Labels', noPreload: true },
      { path: '/images/scan-label-metrics', label: 'Scan Label Metrics' },
      { path: '/images/scan-probe', label: 'Scan Probe' },
      { path: '/images/tags', label: 'Image Tags', countKey: 'imageTags' },
      { path: '/images/ratings', label: 'Image Ratings', countKey: 'imageRatings' },
      { path: '/images/downleveled', label: 'Downleveled' },
      // `informational`: stuck scans are a pipeline fault with no moderator action; summed into
      // the group badge they would read as a review backlog.
      {
        path: '/images/to-ingest',
        label: 'Images to Ingest',
        countKey: 'stuckIngestion',
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
      {
        label: 'Model Flags',
        path: MODEL_FLAGS_PATH,
        tabs: true,
        children: [
          { path: MODEL_FLAGS_APPEALS_PATH, label: 'Appeals', countKey: 'modelFlagsAppeals' },
          { path: MODEL_FLAGS_AUTO_PATH, label: 'Auto-flagged', countKey: 'modelFlagsAuto' },
          // The badge each viewer sees counts only the leads they may rule (`withViewerCountKey`).
          {
            path: MODEL_FLAGS_NEEDS_REVIEW_PATH,
            label: 'Needs review',
            countKey: 'modelFlagsNeedsReview',
          },
        ],
      },
      { path: MODEL_RULE_MATCHES_PATH, label: 'Model rule matches' },
    ],
  },
  {
    label: 'Bounties',
    path: '/bounties',
    children: [
      { path: '/bounties/poi-appeals', label: 'Real-Person Appeals' },
      { path: '/bounties/file-checks', label: 'Entry File Checks' },
    ],
  },
  {
    label: 'Storylines',
    path: '/storylines',
    children: [
      { path: '/storylines/title-appeals', label: 'Title Appeals' },
      { path: '/storylines/early-access', label: 'Early Access Sign-ups' },
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
    ],
  },
  // Every rated entity's owner disputes.
  { path: '/ratings', label: 'Rating Disputes', countKey: 'ratingReviews' },
  { path: '/cosmetics/grant', label: 'Grant Cosmetics' },
  {
    label: 'Items',
    path: '/items',
    children: [
      { path: '/items/definitions', label: 'Item Definitions' },
      { path: '/items/boxes', label: 'Mystery Boxes' },
    ],
  },
  { path: '/creator-services/disputes', label: 'Service Disputes' },
  { path: '/messages', label: 'Civitai Messages', countKey: 'civitaiMessages' },
  {
    label: 'Audit',
    path: '/audit',
    children: [
      { path: '/audit/prohibited-prompts', label: 'Prohibited Prompts' },
      { path: '/audit/prompt-tester', label: 'Prompt Tester' },
      { path: '/audit/scanner-audit', label: 'Scanner Audit' },
      { path: GENERATOR_RESTRICTIONS_PATH, label: 'Generator Restrictions' },
      { path: '/audit/training-models', label: 'Training Models' },
      { path: '/audit/training-data', label: 'Training Data Review' },
      { path: '/audit/relabel', label: 'Removal Label Relabel' },
      { path: '/audit/text-relabel', label: 'Automated Text Relabel' },
    ],
  },
  {
    label: 'Text Scan',
    path: '/text-scan',
    children: [
      { path: '/csam/text-holds', label: 'CSAM holds', countKey: 'csamTextHolds' },
      { path: '/text-scan/prompts', label: 'Prompts' },
      { path: '/text-scan/model-rules', label: 'Model rules' },
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
      { path: '/retool/reactor-lookup', label: 'Reactor Lookup' },
      { path: '/retool/article-lookup', label: 'Article Lookup' },
      { path: '/retool/model-lookup', label: 'Model Lookup' },
      { path: '/retool/bulk-image-manager', label: 'Bulk Image Manager' },
      { path: '/retool/chat-audit', label: 'Chat Audit' },
      // Its own grant, not Chat Audit's: it shows which moderator read whose conversations, which is
      // oversight of the moderators themselves.
      { path: '/retool/chat-audit-log', label: 'Chat Audit Log' },
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
  // Not `informational`: this is a queue somebody works through, so it belongs in the dashboard's
  // "needs attention" total — unlike the stuck-scan counts beside it.
  // One grant covers the queue and its per-report page (`/feedback/<id>`), which resolves here by
  // prefix rather than being listed — the same shape as `/abuse` below. A report is a row of this
  // queue, and granting the list without the rows would show a moderator a count they cannot open.
  //
  // `sharedAccess`, like `/reports`: both children are views of one page, so the grant stays on
  // `/feedback`.
  {
    path: '/feedback',
    label: 'Feedback',
    sharedAccess: true,
    children: [
      { path: '/feedback', label: 'General queue', countKey: 'feedbackNew' },
      {
        path: `/feedback?area=${APPS_PLATFORM_FEEDBACK_AREA}&status=new`,
        label: 'Apps platform (developers)',
        countKey: 'feedbackAppsPlatformNew',
      },
    ],
  },
  // One grant covers the section. Its detail view (`/abuse/<runId>`) resolves here by prefix rather
  // than being listed: a run and its findings are one thing, and granting the list without the rows
  // would show a moderator a count they cannot open.
  { path: '/abuse', label: 'Abuse Detection' },
  // One grant covers the inbox and every source's detail pages (`/decisions/support/<groupKey>`,
  // `/decisions/support/ticket/<id>`), resolved here by prefix like `/abuse`. Recording a ruling is a
  // separate permission (`decisions.rule`), checked in the action.
  { path: '/decisions', label: 'Decisions' },
  { path: '/blocklists', label: 'Blocklists' },
  // No path of its own, so each child carries its own grant (like Users). `/assistant` covers the
  // moderator's own chats, the playbooks and the tool requests by prefix; the audit reads every
  // moderator's conversations, so it is a separate page that nobody holds until granted.
  {
    label: 'Assistant',
    children: [
      { path: '/assistant', label: 'Mod Assistant' },
      { path: '/assistant/audit', label: 'Assistant Audit' },
    ],
  },
  // One grant covers the whole lab. Its sub-pages (labels, runs, docs) resolve here by prefix rather than
  // being listed: they are steps of one loop, and granting a reviewer the queue but not the run history
  // would hide the numbers their review produces.
  { path: '/xguard', label: 'XGuard Lab' },
  // A group with no path of its own, so `/users` stays a grantable page: giving the group `/users` would
  // make it a section, which has no grant — orphaning the stored `/users` row and the ban/purge actions
  // gated on it.
  //
  // Each child carries its OWN grant, and `canAccess` takes the longest matching one. `/users`' grant
  // gates ban, purge and bulk-comment, so a read-only list living under it would make "let them see new
  // signups" mean "let them ban anyone"; likewise a scam reviewer must not gain `/users` by holding
  // `/users/scam-restrictions`.
  {
    label: 'Users',
    children: [
      { path: '/users', label: 'Users' },
      { path: '/users/newest', label: 'Newest Users' },
      { path: SCAM_RESTRICTIONS_PATH, label: 'Scam Restrictions', countKey: 'scamRestrictions' },
      { path: '/users/strike-review', label: 'Strike Review', countKey: 'strikeReview' },
    ],
  },
  // No path of its own, so each queue is granted on its own: whoever handles account appeals need not
  // see the others. A group's grant would be the union of its children.
  {
    label: 'Appeals',
    children: SITE_APPEAL_QUEUES.map((q) => ({
      path: siteAppealQueuePath(q.slug),
      label: q.label,
      countKey: siteAppealCountKey(q.category),
    })),
  },
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
    if (!isEditableGrant(key)) continue;
    const allowed = roles.filter(isStorableRole);
    if (isPermissionKey(key)) nextPermissions[key] = allowed;
    else nextPages[key] = allowed;
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

/** The admin check: holds `moderator:admin`, which reaches everything and grants everything. */
export const isSuper = (user: RoleUser) => (user?.roles ?? []).includes(SUPER_ROLE);

function allows(path: string, user: RoleUser): boolean {
  if (isSuper(user)) return true;
  if (UNRESTRICTED_PATHS.has(path)) return true;
  if (SUPER_ONLY_PATHS.has(path)) return false;
  const match = grants.find((g) => g.path === path);
  return !!match && (user?.roles ?? []).some((r) => match.roles.has(r));
}

/** Needs review lists only the kinds of lead a viewer holds a permission for, so its badge reads the
 *  shared count for exactly those. */
function withViewerCountKey(link: NavLink, user: RoleUser): NavLink {
  if (link.path !== MODEL_FLAGS_NEEDS_REVIEW_PATH) return link;
  return { ...link, countKey: needsReviewCountKey(needsReviewSources(resolvePermissions(user))) };
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
    out.push(withViewerCountKey({ ...link, children }, user));
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

/** The Investigate button: the assistant page AND the right to run it. */
export const canInvestigate = (locals: App.Locals) =>
  canAccess(locals.user, '/assistant') && !!locals.grants['assistant.use'];

/** The training-data viewer: whoever `/api/training-data` would serve, so a page never shows a
 *  button that only answers 403. */
export const canViewTrainingData = (user: RoleUser) =>
  canAccess(user, '/audit/training-data') || canAccess(user, '/audit/training-models');

/** Same grant as User Lookup. */
export const canSeeAddresses = (locals: App.Locals) =>
  canAccess(locals.user, '/retool/user-lookup');

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
  /**
   * Stored roles the editor has no column for, by key: `kept` is carried through a save, `retired` is
   * dropped by it. Shown read-only so neither changes unannounced.
   */
  outside: Record<string, { kept: Role[]; retired: Role[] }>;
} {
  const from = edit
    ? Object.fromEntries(
        Object.entries(edit.grants).map(([p, r]) => [
          p,
          r.filter((role) => edit.roles.includes(role)),
        ])
      )
    : { ...stored, ...storedPermissions };
  const outside: Record<string, { kept: Role[]; retired: Role[] }> = {};
  for (const [key, roles] of Object.entries(edit?.grants ?? {})) {
    const unlisted = roles.filter((role) => isStorableRole(role) && !edit?.roles.includes(role));
    if (unlisted.length)
      outside[key] = {
        kept: unlisted.filter((role) => !isAppRole(role)),
        retired: unlisted.filter(isAppRole),
      };
  }
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
        // Tab routes read as pages of the section on /admin, not as a header of their own.
        if (link.tabs) out.push(...children);
        else if (children.length)
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

  // Listed by grant key, which `/admin` shows in its own column: the id is the name a call site, an
  // audit entry and `denied()` all use, so sorting on it puts each key's actions together.
  const actions = [...PERMISSIONS]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((permission): AccessNode => {
      const key = permissionKey(permission.id);
      granted[key] = from[key] ?? [];
      return { key, label: permission.label, kind: 'permission', children: [] };
    });

  return { tree: walk([...NAVIGATION].sort(byNavOrder)), actions, granted, paths, outside };
}

/** A permission is grantable exactly when it is declared and the page it sits under is itself grantable. */
export function isGrantablePermission(key: string): boolean {
  return !!permissionByKey(key);
}

/** A key a grant may be stored under: a grantable page, or a declared `grant:` permission. */
export const isEditableGrant = (key: string): boolean =>
  isPermissionKey(key) ? isGrantablePermission(key) : isGrantable(key);

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
