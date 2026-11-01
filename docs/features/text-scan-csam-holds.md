# CSAM text holds queue

A moderator-app queue at `/csam/text-holds` (sidebar: Text Scan > CSAM holds) listing `TextScanHold`
rows with label `csam`. A status filter (Pending by default, or Removed / Dismissed / All) and a
sort (oldest first by default, or newest first) narrow the list. Type chips with counts narrow it to
one entity type, and the header search takes a content id, a user id or an author username. Each item shows the
held text as the scan composed it, the model's reason, the author, when the hold and the content were
created, the prompt id and the workflow id, with a link to the content where one exists. Decided
holds open read-only with their outcome, decider, time and note.

Post and Model holds show a row thumbnail and up to four preview tiles, loaded with the page. A
video is a still poster frame with a play icon (it never autoplays, and does not preview on hover
while blurred) and counts toward the total. A tile carries the browsing-level label and, when the
image scan tagged it, a "minor" or "acceptable minor" badge. Tiles are blurred until the page-wide
Reveal toggle (V) is on, and a blurred tile does not link to the original. The preview count caps
at "100+". The model cover selection is shared with the Model Flags pages, which show videos and
the minor tag the same way.

Chat holds show a "Conversation" card: the messages from the first to the last judged one, ten
before and five after, oldest first. Judged messages are highlighted, the sender's other messages
and the other member's are styled apart, deleted and edited messages are labelled, and system
messages are left out. The text is rendered as plain text, is not blurred, and links to the chat in
Chat Audit. It is fetched when a hold is selected (`/api/csam-hold-chat/[holdId]`, which needs the
page and `csam.report.file`), not with the page, and only while the hold still has its meta (the
retention job clears it for old dismissed holds). The surrounding messages, including the other
member's, are Chat Audit's, so they also need access to that page (`/retool/chat-audit`); without it
the card shows only the held sender's judged messages and says the full conversation needs Chat Audit
access, with no link to it.

A profile hold shows a "Profile" card: avatar, cover and SFW cover as captioned tiles (blurred like
every other image) and the bio, message, their SFW variants and location as plain text. A comment
hold shows a "Commented on" card with the parent's title, a link and up to four of its images. A
legacy model `Comment` resolves to its model (the hold row also links to the comment on the model
page). A `CommentV2` resolves to the entity on its `CommentV3` row (a reply carries its entity on its own
row): a post, model, image or article gets the full card, any other entity type shows the type and a
link only, and a comment with no `CommentV3` row (question and answer comments were never migrated)
has no parent card. All
of it is read for the page's holds in one query per type and, like the cover images, a failed read
leaves the card out rather than the page down.

## Where holds come from

The text-scan callback writes a hold when the `csam` label is in review mode and the verdict is
positive; nothing else happens to the content or its author. See the hold paragraph in
[text-scan.md](text-scan.md).

### One hold per entity

Every type except `ChatMessage` keeps at most one Pending hold per entity, backed by a partial
unique index on `(entityType, entityId, label)` where the status is Pending. Rescans only run when
the scanned text changed, so a later detection means new text. `applyCsamHold` reads the entity's
holds in one transaction, under a per-entity advisory lock that a decision's final update takes too,
so a ruling cannot land between the read and the write:

- A Pending hold exists with another text: it is updated in place (text, reason, text hash, workflow,
  prompt, content time, meta) and keeps its queue position. The text it replaces is kept in
  `meta.previous` (text, hash, reason, workflow, when; the five newest, newest first) and the time of
  the replacement in `meta.textUpdatedAt`. A row then reads "text updated 5m" instead of "held 10h",
  and the detail shows both "held" and "text updated" (a hold without the stamp falls back to the
  newest `meta.previous` time). The detail shows the replaced text under "Earlier held text". If the new text is one a moderator already ruled on, the hold
  carries `meta.ruledBefore` (that hold's id and outcome) and the detail says so. A hold with a
  decision in progress (`meta.decisionClaim` younger than 30 minutes) is left alone, and the write
  throws so the callback fails and the retry cron's rescan records the new text later (the claim of a
  decision that crashed is retaken by another decision after 5 minutes, but a new detection only
  after 30).
- The same text as the Pending hold: nothing is written.
- No Pending hold, and the text hash is already decided (dismissed or removed): nothing is written,
  because a moderator ruled on that exact text.
- No Pending hold and changed text after a decision: a new hold is inserted with
  `meta.kind = 'redetected'` and `meta.priorHoldId` set to the latest ruling. The queue shows a
  re-detected chip and "Dismissed before by ... ago" with a link to that hold.
- A clean rescan never closes a Pending hold; a moderator does. When the entity's latest text scan
  (its `EntityModeration` row, the shadow row included) succeeded on a text hash other than the
  hold's with the `csam` label evaluated and not detected, the row and the detail show an "edited
  since" chip and the detail says the latest scan is clean and the held text may no longer be on the
  content. The queue reads this for the whole page in one query, and a failed read only leaves the
  chip off. A chat message hold never shows it, because chat is scanned as a window of messages.

`ChatMessage` holds keep grouping by conversation window and stay unique per text hash.

The moderator app sends the hold's `textHash` with every decision. The main app refuses (409) a
decision whose hash no longer matches, and the moderator is told to reload, so a ruling never applies
to text the moderator did not see. The field is optional on the endpoint for the rollout: without it
the decision is guarded against the hash read at the start of the decision. Migration `20261112120000_text_scan_hold_one_pending` closes
existing duplicate Pending holds as `Dismissed` with `meta.decision = 'superseded'` (shown as
"Superseded by a newer scan"; not a ruling, so it neither blocks nor marks a re-detection). It is
applied by hand. Roll out in this order: migration, then main app release, then moderator release.
Main app code from before this change swallows the new index's unique violation for edited text, so
keep the gap between the migration and the main release short. The moderator ships last because the
old moderator app does not send `textHash`, which the new endpoint accepts but then guards less
strictly. When the migration closes duplicates it keeps the hold a moderator is mid-decision on, else
the one holding the entity's last scanned text, else the newest; run it while nobody is deciding.
It then marks every Pending non-chat hold that has a ruling before it on the same entity (a
dismissed or removed hold with a lower id, superseded ones not counting) with `meta.kind =
'redetected'` and `meta.priorHoldId` set to the latest such ruling, unless a `priorHoldId` is
already there, so a survivor of the cleanup reads "Dismissed before by ..." like a live
re-detection. The file is safe to run again.

Holds are their own table rather than a `CsamReport`, a `Report` or a key in `Model.meta`: csam text
must never reach the user-facing report queue or an entity's meta, and nothing automated acts on it.

Thirty days after a hold is dismissed, the daily `text-scan-retention` job clears its text and meta
(`meta.previous` included); the row, status, reason and ids stay. Confirmed holds are kept whole, text
and meta included. A hold the migration superseded was never reviewed, so it is cleared only once the
hold that replaced it (`meta.supersededBy`) is dismissed too, 30 days after the later of the two
decisions; while that hold is pending, confirmed or missing, the superseded text is kept. A cleared
superseded hold keeps its `superseded` marker, so it is still not read as a ruling.

Only `csam` holds are swept; holds with other labels keep their text.

## Decisions

A moderator picks one of five actions on a Pending hold, with an optional moderator-only note (up to
500 characters). The main app's `/api/mod/text-scan/csam-hold/resolve` owns the write, and the
rules below live in `csam-hold-decision.ts` beside the text-scan actions.

| Action                              | What runs                                                                                  | Hold becomes |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | ------------ |
| Remove content                      | the entity's existing moderator removal                                                    | `Confirmed`  |
| Remove content + strike             | removal, then a strike on the author                                                       | `Confirmed`  |
| Remove content + ban                | removal, then a ban on the author                                                          | `Confirmed`  |
| Remove content + ban + NCMEC report | removal and ban; the moderator then completes the existing CSAM report form for the author | `Confirmed`  |
| Do nothing                          | nothing on the content or the account                                                      | `Dismissed`  |

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
- The endpoint refuses (409) a hold that is missing, no longer Pending or whose text changed since the moderator opened it, and logs every decision to
  Axiom (`text-scan` / `csam-hold-decision`).
- The same endpoint takes `holds: [{ holdId, textHash }]` (at most 50, `remove` or `dismiss` only) to
  decide the author's other pending holds as one call and one rate-limit hit. Each hold is decided on its
  own against its `textHash`; the response lists a result per hold, so a stale or refused hold is
  reported without stopping the rest. A batched hold's label-store record has the reason `batch_apply`
  instead of the action, because nobody opened it. Each hold of a batch is logged to Axiom like a single decision (with `outcome` ok, stale or error); an
  unexpected error is logged by name and code only, never its message.
- Decision keys 1-5 are Dismiss, Remove, Remove + strike, Remove + ban, Ban + file NCMEC report.
  A key is disabled when the content type cannot be removed or the moderator lacks the grant.
  Remove + strike, Remove + ban and the report action still ask for confirmation first; while a
  confirmation is open, decision keys, J/K and V do nothing. K/J move to the next/previous hold, and
  V toggles image reveal.
- Author context. A selected hold with a recorded author shows a card from
  `/api/csam-hold-author/[holdId]`: the author's other holds (every pending one, the newest 50 decided ones, and the total), each
  linking to it. The history needs the page and `csam.report.file`; the account card, content counts
  and reported content are User Lookup's, so only a moderator who can open that page gets them.
  A "same author" chip on a pending row filters the queue to that author's pending holds, and a "same
  chat" chip to their pending chat holds. The filter is the `author` query parameter (a user id),
  which matches only the holds the user wrote; the header search `q` stays as it was and also matches
  content ids, so an id typed there can list holds by someone else.
- Also apply. Deciding the hold on screen with remove or dismiss can cover the author's other pending
  holds that qualify, by checkbox. They go in one batch call (see above), each against the `textHash` its
  listing gave, and are decided without being opened; strike and ban apply to the hold on screen only. A batch is at most 50 holds: when more
  qualify, the confirmation says it covers the first 50 of N and the rest stay pending for the next decision.
- Hiding content while a hold waits is not built: holds stay non-hiding.

## Access

- The page is granted on its own path. Migration
  `20261101120000_moderator_csam_text_holds_page` copies the roles of `/images/csam` onto it; it is
  applied by hand. Until it runs, only `moderator:admin` can open the page.
- Nav visibility = page grant; opening the page and acting = `csam.report.file`. The page load
  refuses (403) a moderator without that permission, the form action checks it again, and so does
  the main-app endpoint. Strike and ban need their own grants on top (see Decisions).
- The sidebar badge (`csamTextHolds`) counts Pending csam holds and refreshes with the sidebar cache.
