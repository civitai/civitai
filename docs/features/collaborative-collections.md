# Collaborative Collections

Members can open a collection to submissions from other users and invite collaborators who help
run it. Two independent halves: **entry acceptance** (anyone submits, an owner or manager approves)
and **collaborators** (named people granted permission on the collection).

Tracker: CU 868kn5ehn.

## Why it is small

Most of the machinery already existed and was driven by collection configuration, not by moderator
status. It was only reachable because moderators alone could set that configuration.

| Capability | Gated on |
| --- | --- |
| Submissions land as `CollectionItemStatus.REVIEW` | `permission.writeReview`, i.e. `write = Review` |
| `/collections/[id]/review` approve/reject queue | `permissions.manage` |
| "Review items" menu entry | `permissions.manage` |
| A non-owner holding `manage` gets all of the above | the `MANAGE` contributor bit |

None of those check `isModerator`, and none require `mode = Contest`. This feature does **not** use
Contest mode — that stays moderator-only, along with its categories, scoring and submission
windows. A community collection is expressed purely as `write = Public` or `write = Review`.

## `write` and contributor bits are orthogonal

`Collection.write` governs **the public** — what any passer-by may do. Contributor permission bits
govern **named people**. `getUserCollectionPermissionsByIds` ORs the two, so a contributor holding
`ADD` resolves to `write = true` regardless of the column.

| `read` | `write` | Collaborators | Result |
| --- | --- | --- | --- |
| Private | Private | none | An ordinary private collection. The default. |
| Private | Private | invited | Private shared collection. Named people only, no public surface. |
| Private | Review | invited | Collaborators submit, the owner approves. |
| Public | Private | none | Publicly viewable, owner-only additions. |
| Public | Public | any | Open collection, no queue. |
| Public | Review | invited Managers | Community collection — the headline case. |

`read` bounds who can submit even when `write` is open: a `Private`-read collection is visible only
to the owner and its contributors, so "open to submissions" there means open to your collaborators.

## `CollectionContributor` is also the follow table

This is the single most important thing to know before touching any of this code.

`follow`/`unfollow` write rows in `CollectionContributor`, and `saveItemInCollections` auto-follows
submitters unless `metadata.disableFollowOnSubmission` is set. On a `write: Public` collection a
plain follower's row is `[VIEW, ADD]`, because `addContributorToCollection` defaults to the
collection's `followPermissions`.

So **"has a row" never means "is a collaborator."** Any query that treats it that way is a
follower-list disclosure — the product exposes only an aggregate follower count, never the members.

The collaborator test is: does the row hold `ADD` or `MANAGE` **beyond** what the collection grants
everyone for free? `freeGrantBaseline(collection)` derives that free set from the collection's own
`read`/`write` columns, and `hasElevatedPermission(permissions, baseline)` applies it. Derive the
baseline from those columns, never from a runtime-filtered permission array.

## Roles

| Role | Bits | Can do |
| --- | --- | --- |
| Contributor | `VIEW`, `ADD` | Add and remove items. |
| Manager | `VIEW`, `ADD`, `MANAGE` | The above, plus work the review queue, edit name/description/cover, and invite Contributors. |

No new permission bits. A Manager may invite and remove **Contributors** only; granting Manager and
removing a Manager are owner-only; the owner is never removable. Changing privacy (`read`/`write`)
and `mode` stays with the owner and moderators — `upsertCollection` strips those fields from anyone
else rather than throwing, so the pre-existing moderator-invited contest-manager path keeps working.

## Invites

`CollectionInvite` holds pending invites, separate from `CollectionContributor` so that follow
semantics stay untouched and a decline leaves no residue.

- Accepting **unions** the role's bits onto whatever the row already has — accepting never takes
  away what following already granted.
- Invites expire after **7 days**, derived from `createdAt`. No `Expired` status and no reaper job;
  stale invites are filtered at read and refused at accept.
- Re-inviting after a decline or expiry upserts (there is a unique constraint on
  `[collectionId, userId]`).
- Caps: **25 collaborators, at most 5 Managers**, both counting non-expired pending invites so an
  owner cannot issue unlimited invites and blow past the cap when they land. The collection owner
  is excluded from both counts and from the roster — they are rendered separately.

The roster is readable by anyone who can read the collection. Pending invites are returned only to
`manage` holders. System-owned (`userId <= 0`) and `mode != null` collections are refused outright.

## Where invites surface

An invitee has to be able to find an invite before it expires, and the collections sidebar is the
only place that knows about them.

- **Mail button in the sidebar header**, carrying the pending count. This is the one affordance that
  renders at **zero** invites, which is why it exists at all — everything else below disappears when
  there is nothing pending, leaving no way in.
- **A band above the filters** peeking at the two most recent invites, with **View all**.
- **The invitations modal**, the full inbox, opened from either.

The count lives on the mail button and **nowhere else**. The band deliberately has no badge: it
would print the same number twice, and it is the button's copy that has to survive the band being
absent.

`getMyInvites` enriches each row with `itemCount` (accepted items only) and `collaboratorCount`
(roster plus the owner) so an invitee can judge what they are being handed. Two things constrain it:
it runs `getCollectionRoster` **per invite**, so the query is bounded by `take: 50`; and it selects
`read`/`write`/`mode`/`userId` purely to run the collaborator-row rule, then maps them off the
result. Do not let those columns reach the client — the roster rule needs them, an invite card does
not.

## Membership gating

Collaboration is a member feature, at any tier. Both opening submissions and inviting collaborators
require an active membership, including on a fully private collection.

Authorization is always against the **owner's** membership, never the actor's — a member Manager
must not be able to invite on behalf of a lapsed owner.

Two separate gates:

1. **Creation** — `upsertCollection` blocks the *transition* into `write = Public`/`Review`, and
   `inviteCollaborator` blocks new invites. Gating the transition rather than the state is what lets
   a lapsed owner keep everything they already built.
2. **Lapse** — `Collection.collaborationDisabledAt`, set by a daily reconciler
   (`reconcile-collection-collaboration.ts`) when the owner has no active membership and cleared
   when they do. `write` is never mutated: the permission resolver is a hot path already selecting
   from `Collection`, so reading one more column is free, whereas overwriting `write` would be lossy
   and need restoring.

The reconciler is bidirectional in one pass, so a missed billing webhook self-heals within a day.
Its scope is deliberately narrow — `mode IS NULL`, owner is a real user, and either `write` is not
`Private` or a non-owner holds elevated permissions. The owner-exclusion matters: owners hold their
own elevated contributor row, so without it the predicate matches essentially every collection.

While disabled, the review queue stays open, existing collaborators keep their permissions, and
already-issued invites can still be accepted. Only new entries and new collaborators stop.

The closed state uses **two separate copy strings** — one for visitors, one for the owner. The
visitor string describes the collection's state and never the owner's billing situation. Keep them
as separate literals; do not template a reason into a shared one.

### Surfacing the gate before the attempt

Because the gate is on the **owner**, a Manager can otherwise pick someone, hit Invite, and get a
failure they have no way to act on. So `getCollaborators` answers it up front:

```ts
{ canInvite: boolean, inviteBlockedReason: 'collaboration-disabled' | 'owner-membership' | null }
```

Three properties hold it together, and all three are load-bearing:

- It **mirrors the refusals `inviteCollaborator` throws**, in the same precedence — lapse first, then
  membership, with moderators bypassing membership but not lapse. The pre-flight answer and the
  write path must not be able to disagree; if you add a refusal to one, add it to the other.
- The reason is returned **only to `manage` holders** (everyone else gets `canInvite: false` with a
  `null` reason). That is what keeps `'owner-membership'` — which does disclose that the owner has
  no active membership — inside the set of people already running the collection. It must never
  widen to read-level callers; the visitor-copy rule above is the same principle.
- The client keeps the **copy**, the server keeps the **reason**. An owner sees an upgrade CTA to
  `/pricing`; a Manager sees that the owner needs a membership. Templating one string for both is
  how the visitor/owner split gets lost.

## Detail header

The header carries the collaboration state: the owner's avatar ringed inside a stack of collaborator
avatars, `<owner> and N collaborators`, and a popover listing the owner plus the first few
collaborators with their roles, `+ N more collaborators`, and a link into the collaborators modal
(**Manage** for `manage` holders, **View all** for everyone else). The count in that sentence
excludes the owner while the avatar stack includes them — deliberate, since the owner is rendered
separately everywhere else too.

`manage` holders also get a **Review N** button to `/collections/[id]/review`, from
`pendingReviewCount` on `collection.getById`. The count is computed only for `manage` holders, and
it is an exact `count` with **no cap and no mode exclusion** — resist adding either.

The reason that is safe is not in `schema.full.prisma`. That file declares only
`@@index([collectionId], type: Hash)` on `CollectionItem`, which would make a status-filtered count
walk the whole collection. Production actually carries
`CollectionItem_collectionId_status_covered` — a btree on `(collectionId, status, createdAt DESC)`
— so the count is an index-only scan: measured at **0.5 ms / 4 buffers** on a 190k-item collection
and **0.8 ms / 73 buffers** for a real 466-row review backlog. This is the same
schema-diverges-from-production trap as the DB triggers; check `pg_indexes` before sizing a query
off the Prisma schema.

## Notifications

`collection-submission-received` goes to the owner and every `MANAGE` holder, resolved at send time,
never to the submitter. `collection-invite-received` goes to the invitee. Both are `toggleable`,
unlike `contest-collection-item-status-change`, which is not, because a submitter must learn the
outcome of their own entry.

## Visibility

There is no feature flag. Collaboration is on for everyone, so each of the guards below is the sole
thing standing between a collection and a published roster — none of them has a second gate behind
it:

- The roster on `collection.getById` is returned only to a caller with `read` permission.
- `getCollaborators` and `getCollectionRoster` return nothing for a curated collection
  (`mode !== null`) or a system-owned one (`userId <= 0`). Curated sets carry staff `ADD`/`MANAGE`
  rows, which are an internal roster and not collaboration.
- A contributor row that only mirrors what the collection already grants everyone belongs to a
  follower, not a collaborator, and is excluded — see "`CollectionContributor` is also the follow
  table" above.

The same exclusions have to hold in the UI. A menu entry or summary gated only on read access will
open a panel for a collection that has no roster to show, and a panel that branches only on
`isLoading`/`data` renders an empty roster — indistinguishable from a collection that genuinely has
no collaborators.

## Outstanding

Known gaps, roughly in the order they'd block a release.

- **The migration has not been applied.**
  `20260806120000_collaborative_collections` is committed for review only — we do not run
  `prisma migrate deploy`. Someone has to run the SQL by hand in each environment before any of this
  works there.
- **The membership CTA has never run in a browser.** Both dev accounts are moderators, and
  moderators bypass the membership gate by design, so the blocked states are covered by unit tests
  and nothing else. Verifying it needs a non-moderator owner with no membership, plus a Manager on
  that owner's collection to see the other half of the split copy.
- **The Manager-facing `owner-membership` copy is an open question.** Telling a Manager that the
  owner needs a membership discloses the owner's billing state to someone who is not the owner. It
  is scoped to `manage` holders on purpose — the alternative, reusing the generic lapse string,
  leaves the Manager with nothing to act on — but that trade has not been signed off. Tightening it
  is one branch in `InviteBlockedNotice`.
- **`collection-invite-received` points at the wrong place.** It links to `/collections/{id}`, which
  an invitee to a `read: Private` collection cannot open — they have no permission until they
  accept. It should route to the invitations inbox instead.
- **`getMyInvites` truncates at 50 silently.** The cap bounds the per-invite roster reads, but
  nothing tells a user with more than 50 pending invites that they are seeing a subset.
- **Deferred from the designs**: the standalone "Manage collaborators" header button, and the
  status chips ("Open to submissions" / "N awaiting review" / "N items"). The actions behind both
  are reachable today, through the context menu and the roster popover.
- **The new UI has no component tests.** `CollectionInvitesModal`, `CollectionInvitesButton` and the
  roster popover are covered only by the service-level tests underneath them.

## Key files

| Area | File |
| --- | --- |
| Permission resolution, `isCollaborator` | `src/server/services/collection.service.ts` (`getUserCollectionPermissionsByIds`) |
| Invites, roster, caps | `src/server/services/collection-collaborator.service.ts` |
| Shared seat definition | `src/server/services/collection-invite.utils.ts` |
| Collaborator-row rule, free-grant baseline | `src/server/services/collection-permission.utils.ts` |
| Lapse reconciler | `src/server/jobs/reconcile-collection-collaboration.ts` |
| Pending-review count | `src/server/services/collection.service.ts` (`getPendingReviewCount`) |
| tRPC surface | `src/server/routers/collection.router.ts` |
| Roster + invite UI | `src/components/Collections/CollectionCollaborators/` |
| Header roster summary | `src/components/Collections/CollectionCollaboratorsSummary.tsx` |
| Sidebar (mail button, invite band) | `src/components/Collections/CollectionsLayout.tsx` |
