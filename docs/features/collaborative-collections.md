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

## Key files

| Area | File |
| --- | --- |
| Permission resolution, `isCollaborator` | `src/server/services/collection.service.ts` (`getUserCollectionPermissionsByIds`) |
| Invites, roster, caps | `src/server/services/collection-collaborator.service.ts` |
| Shared seat definition | `src/server/services/collection-invite.utils.ts` |
| Lapse reconciler | `src/server/jobs/reconcile-collection-collaboration.ts` |
| tRPC surface | `src/server/routers/collection.router.ts` |
| Roster UI | `src/components/Collections/CollectionCollaborators/` |
