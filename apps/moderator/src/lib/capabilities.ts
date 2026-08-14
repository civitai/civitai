/**
 * Every capability a role can be granted inside a page, declared once.
 *
 * NOT under `$lib/server/`: the refusal wording and the grant labels are needed in components too, and
 * when this lived server-side the client re-typed them by hand and drifted — a Bulk Ban banner went on
 * saying "restricted to senior moderators" after the gate became a grant any role could hold. Nothing
 * here touches the grant store, so importing it from a component pulls in no server code.
 */

// A capability's grant key is its own stable `id`, never the page's URL. Keying on the route meant
// renaming a page silently switched off every capability under it — a routing cleanup nobody would
// connect to moderators losing permissions, and `/retool/*` exists only until Retool is retired.
// Route paths always start with `/`, so this prefix cannot collide with one.
const CAPABILITY_PREFIX = 'capability:';

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
   * `page-access.ts`, and intersected with the roles holding every page it requires so it cannot
   * pre-arm anyone. Once a row exists this is ignored forever — `/admin` is the authority from then on.
   */
  defaultRoles: readonly string[];
};

export const CAPABILITIES = {
  editIdentity: {
    id: 'user.identity.edit',
    path: '/retool/user-lookup',
    label: 'Edit email, username & display name',
    requires: ['/users'],
    // Senior is the narrowing Ellie asked for on 2026-08-07 ("other moderators do not have this
    // ability"). Retool's own condition was an authoring bug and grants nothing here — see the design
    // doc; do not reason from it when widening this.
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
export type CapabilityName = keyof typeof CAPABILITIES;

export const ALL_CAPABILITIES: Capability[] = Object.values(CAPABILITIES);

export const capabilityKey = (id: string) => `${CAPABILITY_PREFIX}${id}`;
export const isCapabilityKey = (key: string) => key.startsWith(CAPABILITY_PREFIX);

export const capabilityByKey = (key: string): Capability | undefined =>
  ALL_CAPABILITIES.find((c) => capabilityKey(c.id) === key);

/** The capabilities shown under one page, in declaration order. */
export const capabilitiesOn = (path: string): Capability[] =>
  ALL_CAPABILITIES.filter((c) => c.path === path);

/**
 * Every page a capability needs — its own, plus `requires`. This is the complete set `canUse` checks,
 * so anything deciding whether a role can hold a capability must use it rather than `path` alone.
 * Reasoning from `path` is what let `/admin` offer a tick that saved, rendered checked, and refused.
 */
export const requiredPaths = (capability: Capability): string[] => [
  capability.path,
  ...capability.requires,
];

/**
 * Refusal text, in the exact words `/admin` puts on the checkbox. Hand-written refusals drifted from
 * the labels immediately — three of five named a permission that appears nowhere on the grant screen,
 * so the moderator reading the message could not find the box to ask for.
 *
 * Takes the capability, not its name: every call site sits beside a `canUse(user, CAPABILITIES.x)`, and
 * a key argument let the two halves be edited apart without a type error.
 */
export const denied = (capability: Capability): string =>
  `This action requires the “${capability.label}” permission.`;

/**
 * The roles a capability may actually hold, given who holds the pages it needs. `canUse` requires all of
 * them, so a role granted the capability without them holds something inert — and not stably inert:
 * granting the missing page later activates it with no second decision.
 *
 * The single definition of that rule. Both writers of capability rows use it — the `/admin` save and the
 * default seeding — so a third writer finds it here instead of inventing a fourth interpretation.
 */
export function allowedCapabilityRoles(
  capability: Capability,
  roles: readonly string[],
  pageRoles: (path: string) => readonly string[]
): string[] {
  return roles.filter((role) => requiredPaths(capability).every((p) => pageRoles(p).includes(role)));
}

/**
 * Capability rows that need writing so no capability outgrants the pages it depends on.
 *
 * Covers every declared capability rather than only the ones submitted: narrowing a PAGE has to trim the
 * capabilities under it, and a caller that names only the page would otherwise leave them armed for
 * whoever gets that page next.
 */
export function capabilitySubsetEntries(
  submitted: { path: string; roles: string[] }[],
  stored: Record<string, string[]>
): { path: string; roles: string[] }[] {
  const submittedBy = new Map(submitted.map((e) => [e.path, e.roles]));
  const rolesFor = (path: string): readonly string[] =>
    submittedBy.get(path) ?? stored[path] ?? [];

  const out: { path: string; roles: string[] }[] = [];
  for (const capability of ALL_CAPABILITIES) {
    const key = capabilityKey(capability.id);
    const current = rolesFor(key);
    const allowed = allowedCapabilityRoles(capability, current, rolesFor);
    const wasSubmitted = submittedBy.has(key);
    // Write when the caller asked, or when the rule trims a stored row that nobody named.
    if (wasSubmitted || allowed.length !== current.length) out.push({ path: key, roles: allowed });
  }
  return out;
}

/**
 * What a never-configured environment should start with: one entry per capability with no row yet, its
 * defaults narrowed to the roles that hold every page it requires. A capability whose pages are
 * ungranted seeds empty rather than pre-arming anyone.
 */
export function missingCapabilityRows(
  grants: Record<string, string[]>
): { path: string; roles: string[] }[] {
  return ALL_CAPABILITIES.filter((c) => !(capabilityKey(c.id) in grants)).map((capability) => ({
    path: capabilityKey(capability.id),
    roles: allowedCapabilityRoles(capability, capability.defaultRoles, (p) => grants[p] ?? []),
  }));
}
