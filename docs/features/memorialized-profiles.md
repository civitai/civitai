# Memorialized profiles

A memorialized profile is how Civitai keeps the account of a creator who has died. The profile shows a
grey "Remembering" label and one fixed line ("Remembering <username>. This profile is memorialized so
the work <username> shared stays here for the community."), plus up to three tribute links on a Civitai
site. Everything the creator posted stays exactly as it was.

## What changes

| Stays | Stops |
|---|---|
| Models, versions, images, articles, comments, reviews, collections, follows | Sign-in sessions and API keys (revoked when confirmed) |
| Others can follow, comment, review and remix | New chats to the account, the Tip and Chat buttons |
| | Account deletion, by the owner or a moderator (reverse it first) |
| | Event points (`ExcludeFromEventPoints`, cleared again on reversal only if memorializing set it) |

Payouts are not changed. Whether a memorialized creator's earnings keep accruing is decided case by case.

## How it is set

1. A moderator with the `user.memorialize` permission opens User Lookup → Admin in the moderator app,
   picks how the death was confirmed (family or a close contact, a public obituary or family post, or a
   moderator's first-hand attestation), writes a private note, and adds any tribute links.
2. A **different** moderator confirms. Until then nothing public changes. The service refuses a
   confirmation by the proposer in the same statement that writes the flag.
3. Either step, or one moderator alone, can cancel a proposal or reverse a memorialization.

Each step writes a `ModActivity` row (`memorialPropose`, `memorialConfirm`, `memorialReverse`).
The private note goes to the moderator notes (Notes & Strikes), never to the account row.

## Where it lives

- State: the `Memorialized` bit on `User.flags` (`src/shared/constants/user-flags.constants.ts`) and
  `User.meta.memorial` (shape in `packages/civitai-shared/src/memorial.ts`). Confirming sets both in one
  statement. `User.meta` is not sent to profile viewers; `publicMemorial` gives them the tributes only.
- Service: `src/server/services/memorial.service.ts`; endpoints `/api/mod/user/memorial-propose`,
  `memorial-confirm`, `memorial-reverse`.
- Moderator UI: `apps/moderator/src/routes/retool/user-lookup/MemorialPanel.svelte`.
- Profile UI: `src/components/Profile/MemorialBanner.tsx`, rendered by `ProfileSidebar`.

## Not in v1

- A sign-in lock in the auth hub: revoking sessions is a cut at one moment, so someone with the account's
  email or linked sign-in can sign in again. Planned as its own change.
- Suppressing notifications and emails to the account.
