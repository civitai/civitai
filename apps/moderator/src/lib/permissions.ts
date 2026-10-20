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
  // Apart from cosmetics: a box is a paid product, and one bulk grant reaches many users.
  { id: 'items.boxes.grant', label: 'Grant mystery boxes, and take granted ones back' },
  // Three destructive actions on User Lookup that were gated on the `/users` PAGE grant, so
  // granting a role the new-signups list handed it mass comment deletion, ban and purge in the same
  // tick — a page grant standing in for a permission, which is the weld this app's CLAUDE.md records
  // as having cost the team once already. Separate ids because they are separate decisions: a role can
  // reasonably clear comment spam without being able to end an account, and `user.purge` is the only
  // one of the three with no way back.
  { id: 'user.ban', label: 'Ban or unban an account' },
  { id: 'user.purge', label: 'Purge an account’s content (irreversible)' },
  { id: 'user.comments.bulk', label: 'Bulk delete or ToS an account’s comments' },
  // The main site gates this on the moderator role alone. Narrower here because a take-down answers
  // an ownership or claim dispute — a legal question, not a content one — and the model reports panel
  // puts the button one click from every report in the queue.
  { id: 'model.takeDown', label: 'Take down a model (ownership / claim)' },

  // Also destructive, but never behind the page grant: an erasure request, carried out by the
  // main app's `deleteUser`. That app checks this id by its literal (`ModeratorGrantId` in
  // `src/server/services/moderator-grants.ts`), so rename the two together.
  { id: 'user.deleteAccount', label: 'Delete an account on its owner’s behalf (erasure request)' },
  // Same kind of right, narrower blast radius: the account stays, its reactions go. Checked again by
  // the main app's `/api/mod/user/reactions` and `/remove-reactions` by this literal
  // (`ModeratorGrantId`), so rename the two together.
  { id: 'user.removeReactions', label: 'Remove all of an account’s reactions (erasure request)' },
  // Money: a membership code is worth up to six months of a paid tier. Checked again by the main
  // app's `/api/mod/user/membership-code` by this literal (`ModeratorGrantId`), so rename the two
  // together.
  { id: 'user.membership.code', label: 'Mint membership codes for a customer' },
  // Money: cancels a gifter's payment or refunds it, and ends the recipient's gifted membership.
  // Checked by this literal in the main app's `/api/mod/membership-gift/*` (`ModeratorGrantId`).
  {
    id: 'user.membership.gift',
    label: 'Revoke or refund a membership gift whose payment did not clear',
  },
  // Moves a creator's score, and with it their tier and what the tier unlocks. Checked again by the
  // main app's `/api/mod/user/creator-score-grant` by this literal (`ModeratorGrantId`), so rename the
  // two together.
  { id: 'user.creatorScore.grant', label: 'Grant or revoke Creator Score' },
  // Raises the per-grant ceiling for a holder of `user.creatorScore.grant`; useless without it. Apart
  // because one grant can carry a creator across several tiers. Checked again by the same endpoint
  // by this literal.
  { id: 'user.creatorScore.grantLarge', label: 'Grant more than 10,000 Creator Score at once' },
  // Ends a creator's Buzz earnings from the program. Checked by the main app's
  // `/api/mod/user/creator-program-ban` by this literal (`ModeratorGrantId`), so rename the two together.
  { id: 'user.creatorProgram.ban', label: 'Ban or unban an account from the Creator Program' },
  // The widest read in the app: everything an account generated on-site and in Comfy Cloud, published
  // or not, prompts included. Reaching User Lookup or the restriction queue is not consent to that.
  { id: 'user.generations.view', label: 'View a user’s generated media' },
  // Both were the `/users` PAGE grant until 2026-10-16, so opening the new-signups list conferred them
  // and every report queue withheld them from a Reports-only moderator — the weld this file's header
  // describes. One id per kind of harm, not per page: the same strike, notification and image writes run
  // from User Lookup, every report queue, Image Lookup and Bulk Image Manager, and a gate on one of
  // those pages alone would leave the others as a way round it. Granted by hand on `/admin` at launch.
  { id: 'user.strike', label: 'Strike or notify an account' },
  { id: 'image.moderate', label: 'Remove, restore or flag images' },
  { id: 'bulk-ban.execute', label: 'Run a mass ban' },
  // Reaching a review queue is an investigation right; banning the account it belongs to is not. Held
  // apart so a role can be given the Audit queues without the account-ending half of them.
  { id: 'audit.ban.execute', label: 'Ban an account from an audit queue' },
  // Also checked by the main app's `/api/mod/text-scan/csam-hold/resolve` by this literal (`ModeratorGrantId`
  // in `src/server/services/moderator-grants.ts`); the /csam/text-holds and /csam/evidence-holds page
  // loads refuse without it too, so rename them together.
  { id: 'csam.report.file', label: 'File a CSAM report' },
  // A removal that repeats the reason an approved appeal overturned is held until someone with this
  // confirms it on /images/re-removals; a holder's own such removals apply directly.
  { id: 'image.removal.confirm', label: 'Confirm re-removals of images approved on appeal' },
  // Reading the feedback queue is what the `/feedback` PAGE grant means — there is deliberately no
  // `feedback.read` id, because a permission duplicating a page grant is the weld this file's
  // header records. These two are the writes.
  //
  // Two ids rather than one because the blast radius differs: a status is moderator-only and
  // reversible, while promoting mints a row in `Bug`, the table behind the public Known Issues
  // board. Same split, same reason, as `audit.ban.execute`.
  //
  // ⚠️ THE ID STILL READS `status.set` AND THE NOTE IS GONE, and that mismatch is deliberate: an id
  // is a stored value (rows are keyed `grant:<id>`), so renaming it orphans every grant already
  // ticked on `/admin`. Only the LABEL moved. It used to say "and triage notes", which was true
  // while the panel carried a note box; no UI writes `triageNote` any more, and this label is what
  // an admin reads when deciding to grant and what the panel quotes back when refusing.
  //
  // They launch granted to the SAME roles — a promoted Bug lands with `publishedAt` NULL and is
  // invisible without the `bugsEdit` flag, so the thing that would justify a narrower grant does
  // not exist. Keeping the ids separate is what makes narrowing it later one tick on `/admin`
  // instead of a rename, and a rename orphans stored grant rows.
  { id: 'feedback.status.set', label: 'Set feedback status' },
  { id: 'feedback.bug.promote', label: 'Promote feedback to a Known Issue' },
  { id: 'textScan.prompt.publish', label: 'Publish text-scan prompt versions (production)' },
  { id: 'textScan.modelRules.edit', label: 'Edit Model rules (production)' },
  { id: 'textScan.testSets.edit', label: 'Create and edit text-scan test sets and their cases' },
  // `/decisions`: reading the inbox is the page grant; recording a ruling is this. A ruling is
  // labelled data other systems will train and calibrate on, so who may produce it is its own call.
  { id: 'decisions.rule', label: 'Record a ruling on a decision item' },
  // Held IN ADDITION to `decisions.rule` for a `resolved` ruling. A label trains a model; a canonical
  // answer is text meant to reach customers, so who may write one is a separate, narrower call.
  { id: 'decisions.answer', label: 'Record the canonical answer for a decision group' },
  // Support tickets carry the requester's email, a different class of data from anything moderation
  // shows. Without this the email is never even selected — see `ticketSql`.
  { id: 'decisions.support.pii', label: 'See support-ticket requester emails on Decisions' },
  { id: 'scan-label.quota.edit', label: 'Set scan label voters and their daily quotas' },
  // Submits a real scan with the site's system account; the page shows signals only.
  { id: 'image.scanProbe.run', label: 'Run the image scanner on chosen images (signals only)' },
  // Moves held Buzz: a Refund returns it to the buyer, a Release pays the seller. Checked again by the
  // main app's `/api/mod/creator-services/resolve-dispute` by this literal (`ModeratorGrantId`), so
  // rename the two together. Reading the queue is the page grant.
  {
    id: 'creatorServices.resolveDispute',
    label: 'Resolve a Creator Services dispute (refund or release Buzz)',
  },
  // Checked by this literal in the main app's `/api/mod/label-store/predictions` (`ModeratorGrantId`).
  { id: 'labelStore.submitPrediction', label: 'Submit model predictions to the label store' },
  // Model Flags → Needs review lists two kinds of lead, each ruled by its own right: a held text-scan
  // detection (flag or dismiss, recorded with a reason) and a file match (set minor or dismiss). The
  // page grant opens the tab; the tab lists, and its actions rule, only the kinds held here.
  {
    id: 'modelFlags.detections.decide',
    label: 'Flag or dismiss held text-scan detections (Model Flags)',
  },
  { id: 'modelFlags.fileMatches.decide', label: 'Flag or dismiss file matches (Model Flags)' },
  // Page access is `/assistant`; this is the right to run turns (model spend), so a role can see the
  // page and audit without running them.
  { id: 'assistant.use', label: 'Ask the mod assistant and edit its playbooks' },
  // Sends account registration emails to the model provider, a separate call from running turns. Also
  // needs User Lookup, where a moderator reads emails today.
  { id: 'assistant.emails', label: 'Let the mod assistant read account registration emails' },
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
