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

// Splits a feature's grant key from the page it belongs to. `#` is the one character a pathname can
// never contain — a URL fragment is not sent to the server — so a feature row cannot be reached by
// `canAccess`'s prefix walk even if it were mixed into the page map.
// A capability's grant key is its own stable `id`, never the page's URL. Keying on the route meant
// renaming a page silently switched off every capability under it — a routing cleanup nobody would
// connect to moderators losing permissions, and `/retool/*` exists only until Retool is retired.
// Route paths always start with `/`, so this prefix cannot collide with one.
const CAPABILITY_PREFIX = 'capability:';
export const capabilityKey = (id: string) => `${CAPABILITY_PREFIX}${id}`;
export const isCapabilityKey = (key: string) => key.startsWith(CAPABILITY_PREFIX);

type CapabilityDef = {
  /** Stable storage id. Renaming it orphans existing grants — treat it like a column name. */
  id: string;
  /** The page it is shown under, and the first thing it requires. */
  path: string;
  label: string;
  /** Other pages the capability also needs. Every term of the gate lives here — see `canUse`. */
  requires: readonly string[];
  /**
   * Who holds it on an environment that has never been told about it. Applied once, by the reconcile in
   * `page-access.ts`, and intersected with the roles actually holding `path` so it cannot pre-arm anyone.
   * Once a row exists this is ignored forever — `/admin` is the authority from then on.
   */
  defaultRoles: readonly string[];
};

/**
 * A capability inside a page, granted separately from the page itself. Retool expressed these as a
 * pane-level `only visible when` condition rather than as anything a query could show, which is how
 * three were ported as a hardcoded senior check and a fourth as no check at all.
 *
 * Declared once, here, and read by everything: the `/admin` tree, the gate, and the `whoami`
 * diagnostic all derive from this object rather than repeating it. Call sites take a whole entry
 * rather than a `(path, key)` pair — an unstored feature denies silently, so a mistyped key would be a
 * permission that reads as "nobody has it" with nothing to catch it.
 */
export const CAPABILITIES = {
  editIdentity: {
    id: 'user.identity.edit',
    path: '/retool/user-lookup',
    label: 'Edit email, username & display name',
    requires: ['/users'],
    // Ungated in our code before this layer existed; Retool allowed everyone but Volunteer Mod. Senior
    // is the narrowing Ellie asked for on 2026-08-07 ("other moderators do not have this ability").
    defaultRoles: ['moderator:senior'],
  },
  sendBuzz: {
    id: 'user.buzz.send',
    path: '/retool/user-lookup',
    label: 'Send or deduct Buzz',
    requires: ['/users'],
    defaultRoles: ['moderator:senior'],
  },
  viewBankBuzz: {
    id: 'user.buzz.bank',
    path: '/retool/user-lookup',
    label: 'See bank transactions in Buzz history',
    // Deliberately empty: reading the ledger is an investigation, and `/users` is the grant to ACT on
    // an account. Stated rather than omitted so the difference from its five siblings is legible.
    requires: [],
    defaultRoles: ['moderator:senior'],
  },
  toggleModerator: {
    id: 'user.moderator.toggle',
    path: '/retool/user-lookup',
    label: 'Activate or deactivate moderator',
    requires: ['/users'],
    defaultRoles: ['moderator:senior'],
  },
  grantCosmetics: {
    id: 'user.cosmetics.grant',
    path: '/retool/user-lookup',
    label: 'Grant cosmetics',
    requires: ['/users'],
    // Admin-only, and admins bypass grants entirely. Retool hid the badge-grant modal unless
    // `groups.some(i => i.name === 'admin')` — the narrowest condition of the six.
    defaultRoles: [],
  },
  massBan: {
    id: 'bulk-ban.execute',
    path: '/retool/bulk-ban',
    label: 'Run a mass ban',
    requires: ['/users'],
    defaultRoles: ['moderator:senior'],
  },
} as const satisfies Record<string, CapabilityDef>;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export const ALL_CAPABILITIES: Capability[] = Object.values(CAPABILITIES);

/** The capabilities shown under one page, in declaration order. */
export const capabilitiesOn = (path: string): Capability[] =>
  ALL_CAPABILITIES.filter((c) => c.path === path);

/**
 * Refusal text, in the exact words `/admin` puts on the checkbox. Hand-written refusals drifted from
 * the labels immediately — three of five named a permission that appears nowhere on the grant screen,
 * so the moderator reading the message could not find the box to ask for.
 */
export const denied = (name: keyof typeof CAPABILITIES): string =>
  `This action requires the “${CAPABILITIES[name].label}” permission.`;

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
    ],
  },
  {
    label: 'Retool',
    path: '/retool',
    children: [
      {
        path: '/retool/user-lookup',
        label: 'User Lookup',
        // Reading an account is the page; acting on one is not. Buzz movement, balance and bounties
        // stay ungated — only the send/deduct action and the bank rows are restricted. The capabilities
        // themselves are declared in CAPABILITIES and attach by path; there is nothing to wire here.
      },
      { path: '/retool/image-lookup', label: 'Image Lookup' },
      { path: '/retool/article-lookup', label: 'Article Lookup' },
      { path: '/retool/user-reports', label: 'User Reports' },
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
  { path: '/blocklists', label: 'Blocklists' },
  // One grant covers the whole lab. Its sub-pages (labels, runs, docs) resolve here by prefix rather than
  // being listed: they are steps of one loop, and granting a reviewer the queue but not the run history
  // would hide the numbers their review produces.
  { path: '/xguard', label: 'XGuard Lab' },
  { path: '/users', label: 'Users' },
  { path: '/admin', label: 'Permissions' },
  { path: '/page-visits', label: 'Page Usage' },
];

// App-global, not per-user, so sharing module state across concurrent requests is safe. Features are held
// apart from pages rather than filtered out at every read: `grants` drives route gating, and a key that
// can never be a route has no business in it.
let stored: Partial<Record<string, Role[]>> = {};
let storedFeatures: Partial<Record<string, Role[]>> = {};

export function applyGrants(map: Record<string, string[]>): void {
  const nextPages: Partial<Record<string, Role[]>> = {};
  const nextFeatures: Partial<Record<string, Role[]>> = {};
  for (const [key, roles] of Object.entries(map)) {
    const allowed = roles.filter(isGrantableRole);
    if (isCapabilityKey(key)) {
      if (isGrantableFeature(key)) nextFeatures[key] = allowed;
    } else if (isGrantable(key)) nextPages[key] = allowed;
  }
  if (sameGrants(nextPages, stored) && sameGrants(nextFeatures, storedFeatures)) return;
  stored = nextPages;
  storedFeatures = nextFeatures;
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

/**
 * Whether a role may use one capability inside a page. Conjunctive by design: losing the page loses
 * every feature on it, and ticking a feature for a role that cannot open the page grants nothing.
 *
 * An undeclared or unstored feature allows nobody, so a load failure and a deliberate revoke both fail
 * closed — the same rule pages already run on.
 */
export function canUse(user: RoleUser, capability: Capability): boolean {
  if (isSuper(user)) return true;
  if (!canAccess(user, capability.path)) return false;
  // Every term of the gate, so the answer is the same wherever it is asked. When `requires` lived at the
  // call sites instead, `whoami` reported a capability the action then refused — on the endpoint whose
  // whole job is settling that question.
  if (capability.requires.some((path) => !canAccess(user, path))) return false;
  const roles = storedFeatures[capabilityKey(capability.id)] ?? [];
  return (user?.roles ?? []).some((r) => roles.includes(r as Role));
}

/** The effective feature→roles map, for diagnostics. Pair with `grantsSnapshot`. */
export function featureGrantsSnapshot(): Record<string, Role[]> {
  return Object.fromEntries(
    allFeatureKeys().map((key) => [key, [...(storedFeatures[key] ?? [])]])
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
  kind: 'group' | 'page' | 'feature';
  parent?: string;
  // A feature's label is only unique within its page — "Grant cosmetics" the capability and "Grant
  // Cosmetics" the page are one string to a screen reader, on a screen where ticking the wrong box is
  // the failure mode.
  parentLabel?: string;
  children: AccessNode[];
};

// The admin page's editing surface: only what a role can actually be granted, with only the roles that
// can hold a grant. What isn't stored isn't checked — there are no implied grants to display.
// `source` lets the admin page pass grants read straight from Postgres; omitting it falls back to the
// request cache, which is fine for read-only callers but never for the editing surface.
export function pageAccessState(source?: Record<string, string[]>): {
  tree: AccessNode[];
  granted: Record<string, Role[]>;
  /** Every routable path in the tree, groups included — what `whoami` reports verdicts for. */
  paths: string[];
} {
  const from = source
    ? Object.fromEntries(Object.entries(source).map(([p, r]) => [p, r.filter(isGrantableRole)]))
    : { ...stored, ...storedFeatures };
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
        if (children.length) out.push({ key: link.path, label: link.label, kind: 'group', children });
        continue;
      }
      const path = link.path;
      paths.push(path);
      if (!isGrantable(path)) continue;
      granted[path] = from[path] ?? [];
      const features = capabilitiesOn(path).map((capability): AccessNode => {
        const key = capabilityKey(capability.id);
        granted[key] = from[key] ?? [];
        return {
          key,
          label: capability.label,
          kind: 'feature',
          parent: path,
          parentLabel: link.label,
          children: [],
        };
      });
      out.push({ key: path, label: link.label, kind: 'page', children: features });
    }
    return out;
  };

  return { tree: walk([...NAVIGATION].sort(byNavOrder)), granted, paths };
}

/** Every declared capability key, whether or not it has ever been granted. */
export function allFeatureKeys(): string[] {
  return ALL_CAPABILITIES.map((c) => capabilityKey(c.id));
}

const capabilityByKey = (key: string) =>
  ALL_CAPABILITIES.find((c) => capabilityKey(c.id) === key);

/** A capability is grantable exactly when it is declared and the page it sits under is itself grantable. */
export function isGrantableFeature(key: string): boolean {
  const capability = capabilityByKey(key);
  return !!capability && isGrantable(capability.path);
}

/** The page a capability key sits under — the grant it is meaningless without. */
export function featurePagePath(key: string): string | undefined {
  return capabilityByKey(key)?.path;
}

/**
 * What a never-configured environment should start with: one entry per capability that has no row yet,
 * with its defaults narrowed to the roles that actually hold the owning page. Applied by the reconcile in
 * `page-access.ts`; a capability whose page is ungranted seeds empty rather than pre-arming anyone.
 */
export function missingCapabilityRows(
  grants: Record<string, string[]>
): { path: string; roles: string[] }[] {
  return ALL_CAPABILITIES.filter((c) => !(capabilityKey(c.id) in grants)).map((c) => {
    const pageRoles = grants[c.path] ?? [];
    return {
      path: capabilityKey(c.id),
      roles: c.defaultRoles.filter((role) => pageRoles.includes(role)),
    };
  });
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
