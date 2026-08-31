/**
 * Every permission a role can be granted, declared once.
 *
 * A permission is a named right to DO something, granted to roles. It is deliberately independent of
 * page access, which is a separate axis answering what a role may OPEN: an action sits behind both, and
 * they are composed where the action runs rather than welded together here. They were welded once —
 * each permission named the page it lived on plus the pages it required, and the check demanded all of
 * them. `/users` was never built, so five permissions seeded to nobody, could not be granted on
 * `/admin`, and quietly became admin-only. Which pages exist is not a permissions question.
 *
 * NOT under `$lib/server/`: the refusal wording and the grant labels are needed in components too, and
 * when this lived server-side the client re-typed them by hand and drifted — a Bulk Ban banner went on
 * saying "restricted to senior moderators" after the gate became a grant any role could hold. Nothing
 * here touches the grant store, so importing it from a component pulls in no server code.
 */

// 🔴 STORED VALUE. Every grant row is keyed `grant:<id>`, so this prefix and each `id` below are column
// names, not labels: changing one orphans its rows silently — the grant is not revoked, it is simply
// no longer found, which reads as a permission that stopped working for nobody's reason. Renamed from
// `capability:` on 2026-08-19 with the existing rows repointed by hand.
// Route paths always start with `/`, so this cannot collide with one.
const PERMISSION_PREFIX = 'grant:';

/**
 * The id is the ONLY name a permission has — the same literal in the grant row, on the `/admin` screen
 * and at every call site, so one grep answers "who can do this and does this user hold it". An earlier
 * shape carried a friendly key beside the id and the two drifted apart in the reader's head.
 */
export const PERMISSIONS = [
  { id: 'user.identity.edit', label: 'Edit email, username & display name' },
  { id: 'user.buzz.send', label: 'Send or deduct Buzz' },
  { id: 'user.buzz.bank', label: 'See bank transactions in Buzz history' },
  { id: 'user.moderator.toggle', label: 'Activate or deactivate moderator' },
  { id: 'user.cosmetics.grant', label: 'Grant cosmetics' },
  // The three account-ending actions on User Lookup. They were gated on the `/users` PAGE grant, so
  // granting a role the new-signups list handed it mass comment deletion, ban and purge in the same
  // tick — a page grant standing in for a permission, which is the weld this app's CLAUDE.md records
  // as having cost the team once already. Separate ids because they are separate decisions: a role can
  // reasonably clear comment spam without being able to end an account, and `user.purge` is the only
  // one of the three with no way back.
  { id: 'user.ban', label: 'Ban or unban an account' },
  { id: 'user.purge', label: 'Purge an account’s content (irreversible)' },
  { id: 'user.comments.bulk', label: 'Bulk delete or ToS an account’s comments' },
  { id: 'bulk-ban.execute', label: 'Run a mass ban' },
  // Reaching a review queue is an investigation right; banning the account it belongs to is not. Held
  // apart so a role can be given the Audit queues without the account-ending half of them.
  { id: 'audit.ban.execute', label: 'Ban an account from an audit queue' },
  { id: 'csam.report.file', label: 'File a CSAM report' },
] as const satisfies readonly { id: string; label: string }[];

export type Permission = (typeof PERMISSIONS)[number];
export type PermissionId = Permission['id'];

/**
 * What a user holds. Granted permissions only — an absent key is not held, which is also what an
 * unloaded grant store looks like, and both read false. So `Object.keys` is the held list, and there is
 * no second representation to keep in step.
 *
 * FLAT, keyed by the dotted id rather than nested along it: a nested shape would make an intermediate
 * node absent for anyone holding none of that branch, so `permissions.user.buzz.send` would THROW for
 * exactly the user who lacks it. Falsy is the behaviour this has to have.
 */
export type PermissionSet = Partial<Record<PermissionId, true>>;

const BY_ID = new Map<string, Permission>(PERMISSIONS.map((p) => [p.id, p]));

export const permissionKey = (id: string) => `${PERMISSION_PREFIX}${id}`;
export const isPermissionKey = (key: string) => key.startsWith(PERMISSION_PREFIX);

export const permissionById = (id: PermissionId): Permission => BY_ID.get(id) as Permission;

export const permissionByKey = (key: string): Permission | undefined =>
  BY_ID.get(key.slice(PERMISSION_PREFIX.length));

/**
 * Refusal text, in the exact words `/admin` puts on the checkbox. Hand-written refusals drifted from
 * the labels immediately — three of five named a permission that appears nowhere on the grant screen,
 * so the moderator reading the message could not find the box to ask for.
 */
export const denied = (id: PermissionId): string =>
  `This action requires the “${permissionById(id).label}” permission.`;
