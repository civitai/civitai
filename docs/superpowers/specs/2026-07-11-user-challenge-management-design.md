# User Challenge Management — Design

**Date:** 2026-07-11
**Status:** Approved (design), pending implementation plan
**Related:** Public challenges v1 (ClickUp 868k8z86x)

## Problem

Public-challenges v1 opened challenge **creation** to normal users (`/challenges/create` →
`upsertUserChallenge`, gated by the `userChallenges` flag). But there is **no user-facing way to
see or manage the challenges they created**:

- No "my challenges" listing — no nav link, no profile tab, no "created by me" feed filter. The
  `getInfinite` `userId` creator filter exists but nothing in the UI passes it.
- No user edit route. Only `/moderator/challenges/[id]/edit` is wired; `getForEdit` is
  `moderatorProcedure`, so even a `source=User` challenge is only editable through the mod UI.
- The challenge detail page context menu is moderator-gated. A regular creator viewing their own
  challenge gets only "Report".

The backend already supports owner edits (`upsertUserChallenge` with `id`: guards
`createdById === userId`, `status === Scheduled`, zero entries). The gap is almost entirely UI
plumbing plus one new delete procedure.

## Scope

**In scope — creator actions on their own `source=User` challenge, all only while `Scheduled`
with 0 entries:**

- **View** their challenges (all statuses) via a "My Challenges" filter on `/challenges`.
- **Edit** while `Scheduled` + 0 entries (backend already allows this).
- **Delete** while `Scheduled` + 0 entries ("no entry fees charged"); delete refunds the creator's
  escrowed prize buzz.

**Out of scope (unchanged):**

- End / void / pick-winners stay **moderator-only** (v1 "mods-own-ending" decision). Not touched.
- Once a challenge is `Active`/`Completing`/`Completed`, the creator's view is read-only.

**Follow-up (not this spec):** Bounties have the same shape of gap (a creator only surfaces their
own via `engagement=favorite`, with no dedicated "created by me" management view). Mirroring this
work for bounties is a separate task; noted here because it prompted the request.

## Placement decision

Mirror the **bounty** pattern (chosen over a profile tab or a dedicated `/challenges/manage`
dashboard): cheapest, consistent with an existing surface, and reuses the already-wired
`getInfinite` `userId` filter.

```
Nav: user menu → "My Challenges"
  → /challenges?engagement=created
     [ Scheduled | Active | Completed ]   ← status SegmentedControl
     └ masonry of MY challenges
        └ card / detail menu: Edit · Delete   (only while Scheduled + 0 entries)
```

## Design

### Server

**1. `deleteUserChallenge` — new `protectedProcedure`** (`challenge.router.ts`), wrapped with
`isFlagProtected('userChallenges')` (like `upsertUserChallenge`), `requiredScope: SocialWrite`,
`blockApiKeys: true`.

Guards (in the service): load the challenge, then assert
- `source === ChallengeSource.User`
- `createdById === ctx.user.id` ("You can only delete your own challenges")
- `status === ChallengeStatus.Scheduled`
- entry count `=== 0` (no participant has paid an entry fee) — reuse the entry-count check the
  edit path already uses.

Then delegate to the existing `deleteChallenge(id)` service fn (`challenge.service.ts:1512`),
which already:
- refunds the creator's escrowed prize for `source=User` + `Scheduled` via
  `refundUserChallengeFunds` (`:1539-1541`),
- deletes the challenge (cascades to `ChallengeWinner`) and its collection + search-index entry.

No new refund/delete logic. The new proc is a thin owner/status-guarded wrapper. (The existing
mod `delete` proc stays as-is.)

**2. User-safe edit fetch — new thin `getUserChallengeForEdit` `protectedProcedure`.** `getForEdit`
is `moderatorProcedure`; rather than loosen it, add a small protected proc that loads the challenge,
asserts owner + `source===User` + `status===Scheduled`, and returns the user-editable subset the
`variant="user"` form consumes. Feeds the new edit route.

**3. Read side — no changes.** `getInfinite` already:
- filters `userId` → `c."createdById" = userId` (`challenge.service.ts:384`),
- accepts `status[]` (`:362`),
- exempts the creator from the moderation scan gate (`:355`, `ingestion='Scanned' OR createdById=currentUserId`).
- User challenges are created with `visibleAt = now()` (`:1415`), so a just-created `Scheduled`
  challenge passes the `visibleAt <= now()` gate and shows to its creator immediately.

### Client

**1. Nav link.** Add "My Challenges" to the user dropdown → `/challenges?engagement=created`,
visible only when signed in and `features.userChallenges`. Mirror the "My Bounties" entry in
`src/components/AppLayout/AppHeader/hooks.tsx:121`.

**2. `/challenges` index "My Challenges" mode.** In `src/pages/challenges/index.tsx`, when the
`engagement=created` query param is present: render a "My Challenges" `<Title>` + a status
`SegmentedControl` (Scheduled / Active / Completed) and pass `userId: currentUser.id` + selected
`status` into the community feed. Without the param, the page is unchanged (public feed). Mirror
`src/pages/bounties/index.tsx:36-51`. Add the `engagement`/`created` param to the challenge
query-params util (mirror `bounty.utils.ts` query-params schema).

**3. Owner context menu.** On the community-feed challenge card and on the detail page context menu
(`src/pages/challenges/[id]/[[...slug]].tsx:310`), show **Edit** (→ `/challenges/[id]/edit`) and
**Delete** when `currentUser?.id === challenge.createdById && source === ChallengeSource.User &&
status === ChallengeStatus.Scheduled`. Mirror the ownership check + item gating in
`src/components/Bounty/BountyContextMenu.tsx`.

**4. New `/challenges/[id]/edit.tsx` (user route).** SSR gate: signed in, `userChallenges` flag,
load challenge, redirect to `/challenges/[id]` unless `createdById === session.user.id &&
source === User && status === Scheduled` (mirror the SSR owner gate in
`src/pages/bounties/[id]/edit.tsx:38-47`). Renders
`<ChallengeUpsertForm variant="user" challenge={...} />`. The form already supports edit mode
(`challenge` prop / `isEditing`); today only the mod route feeds it.

**5. Delete confirmation.** A confirm modal (buzz-refund messaging) + a mutation hook wiring
`trpc.challenge.deleteUserChallenge`, with query invalidation of the "My Challenges" feed. Mirror
the delete flow in `useMutateBounty` / `BountyContextMenu`.

## Guards / gating summary

| Action | Where | Condition |
|--------|-------|-----------|
| See "My Challenges" | nav + index | signed in + `features.userChallenges` |
| View own (incl. pre-scan `Scheduled`) | `getInfinite` | `userId=self`; scan gate exempts creator |
| Edit | route + `upsertUserChallenge` | owner + `source=User` + `Scheduled` + 0 entries |
| Delete | route + `deleteUserChallenge` (new) | owner + `source=User` + `Scheduled` + 0 entries → refund |
| End / void / pick winners | mod only | unchanged |

## Data model

No schema changes. Uses existing `Challenge.createdById`, `Challenge.source` (`ChallengeSource.User`),
`Challenge.status` (`ChallengeStatus.Scheduled`), and the entries-via-collection model. (Note: the
committed migration `20260706130000_public_challenges_v1_schema` is ahead of `schema.prisma`'s
`Challenge` model — the design relies on the applied DB / service reality, not the stale slim schema.)

## Testing

- **`deleteUserChallenge` service** (Vitest, `src/server/**/__tests__/` — never under `src/pages`):
  - owner + Scheduled + 0 entries → deletes + refunds (assert `refundUserChallengeFunds` /
    `deleteChallenge` invoked; challenge + collection gone).
  - rejects: non-owner, `source !== User`, `status !== Scheduled`, entries > 0.
- **Edit route SSR gate**: non-owner / non-Scheduled / wrong source → redirect to `/challenges/[id]`.
- **Index "My Challenges" mode**: `engagement=created` passes `userId=self` + `status`; without it,
  public feed unchanged.
- **Context menu**: Edit/Delete render only for owner of a `source=User` `Scheduled` challenge.

## Risks / notes

- **Delete race with activation.** A `Scheduled` challenge can flip to `Active` via the activation
  job. The edit path already guards writes on `status: Scheduled` to avoid racing it; the delete
  proc must do the same — re-check `status === Scheduled` at delete time (the existing
  `deleteChallenge` blocks `Active` and only refunds `Scheduled`, so a lost race fails safe rather
  than double-refunding).
- **Entry-count definition.** "No entry fees charged" = 0 entries in the challenge's collection.
  Confirm this is the same signal the edit guard uses so edit and delete stay consistent.
