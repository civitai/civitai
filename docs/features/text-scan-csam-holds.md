# CSAM text holds queue

A moderator-app queue at `/csam/text-holds` (sidebar: Text Scan > CSAM holds) listing every Pending
`TextScanHold` row with label `csam`, oldest first. Each item shows the held text as the scan
composed it, the model's reason, the author, when the hold and the content were created, the prompt
id and the workflow id, with a link to the content where one exists. It can be narrowed to one
entity type.

## Where holds come from

The text-scan callback writes a hold when the `csam` label is in review mode and the verdict is
positive; nothing else happens to the content or its author. See the hold paragraph in
[text-scan.md](text-scan.md).

Holds are their own table rather than a `CsamReport`, a `Report` or a key in `Model.meta`: csam text
must never reach the user-facing report queue or an entity's meta, and nothing automated acts on it.

Thirty days after a hold is dismissed, the daily `text-scan-retention` job clears its text and meta;
the row, reason, ids and decision stay. Confirmed holds are kept whole, text and meta included.

## Decisions

A moderator picks one of five actions on a Pending hold, with an optional moderator-only note (up to
500 characters). The main app's `/api/mod/text-scan/csam-hold/resolve` owns the write, and the
rules below live in `csam-hold-decision.ts` beside the text-scan actions.

| Action | What runs | Hold becomes |
|---|---|---|
| Remove content | the entity's existing moderator removal | `Confirmed` |
| Remove content + strike | removal, then a strike on the author | `Confirmed` |
| Remove content + ban | removal, then a ban on the author | `Confirmed` |
| Remove content + ban + NCMEC report | removal and ban; the moderator then completes the existing CSAM report form for the author | `Confirmed` |
| Do nothing | nothing on the content or the account | `Dismissed` |

- Removal reuses what a moderator already uses for each type, and keeps the content: a ToS-violation
  flag for `Comment` and `CommentV2`, a profile-field clear for `UserProfile`, an
  unpublish-as-violation for `Model`, a moderator unpublish for `Post` (`publishedAt` cleared and the
  `unpublishedAt` / `unpublishedBy` / `prevPublishedAt` stamps written, post and images kept, images
  taken out of the search index; a republish restores it), the chat soft delete (row and content
  retained, audited) for `ChatMessage`, and `UnpublishedViolation` for `Article` (through the
  moderator unpublish when it is Published; set directly when it is a draft, scheduled, processing or
  owner-unpublished, under the article's ingestion lock, so it cannot go live later). Nothing is destroyed, so content stays available for an
  NCMEC report. A type outside this list is refused (400) and only "Do nothing" applies.
- The ban skips an author who is already banned, because the ban service toggles. No decision files
  an NCMEC report or creates a `Report` row; the fourth action opens the CSAM report form
  (`/moderator/csam/<userId>`) once the removal and ban have succeeded.
- Strike and ban are held to the moderator-app grants they carry elsewhere (`user.strike`,
  `user.ban`) in addition to `csam.report.file`, in the page action and again in the endpoint.
- Content, strike and ban run first, each safe to repeat; the hold update and its `label_store`
  record (`record_label`, question `csam_text.verdict`, value `csam` or `not_csam`, the action as
  the reason) are then one transaction. If anything fails the hold stays Pending and the same
  decision can be sent again. The action is also kept in the hold's `meta.decision`.
- The endpoint refuses (409) a hold that is missing or no longer Pending, and logs every decision to
  Axiom (`text-scan` / `csam-hold-decision`).
- Destructive actions ask for confirmation before submitting; none has a keyboard shortcut.
- Hiding content while a hold waits is not built: holds stay non-hiding.

## Access

- The page is granted on its own path. Migration
  `20261101120000_moderator_csam_text_holds_page` copies the roles of `/images/csam` onto it; it is
  applied by hand. Until it runs, only `moderator:admin` can open the page.
- Nav visibility = page grant; opening the page and acting = `csam.report.file`. The page load
  refuses (403) a moderator without that permission, the form action checks it again, and so does
  the main-app endpoint. Strike and ban need their own grants on top (see Decisions).
- The sidebar badge (`csamTextHolds`) counts Pending csam holds and refreshes with the sidebar cache.
