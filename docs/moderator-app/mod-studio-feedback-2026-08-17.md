# Mod Studio feedback — running checklist

The moderation team reviews the app in a feedback channel and reports as they go. This file is the single
place to see what they asked for and whether it is done, so the state does not have to live in code
comments or in a chat scrollback.

**Scope:** everything reported between 2026-08-05 and 2026-08-18.

Where the detail already exists, this file links rather than copies:

- **[`retool-parity-checklist.md` §12](retool-parity-checklist.md#12-moderation-team-feedback-round--2026-08-12--08-13)**
  — the 08-12/08-13 round, item by item, with the SQL and the widget-level analysis.
- **[`retool-migration-handover.md`](retool-migration-handover.md)** — the operational steps (env,
  migrations, page grants) only a person can run.
- **[`post-migration-backlog.md`](post-migration-backlog.md)** — improvements Retool never had. Anything
  below that turns out to be an improvement rather than a gap belongs there.

Reporter identities, message links and quotes are deliberately absent: this repo is public
(CLAUDE.md → Security). The private triage keeps attribution.

> **Update this file in the same commit as the fix**, with a one-line outcome and the sha. An unticked box
> with no note reads as "nobody looked", which is the failure mode this file exists to prevent.

> **Open items from this round have moved** to
> [`mod-studio-feedback-2026-08-19.md`](mod-studio-feedback-2026-08-19.md), so there is one live list
> rather than boxes to tick in two files. They keep the date they were first raised. What stays here is
> the record of what this round reported and what shipped — moved items appear below as plain bullets
> with their reasoning intact, and no checkbox.

**Items are not announced back to the reporters individually.** Replying per item as things land adds
noise for a team who mostly want the tool to work, so release notes carry what changed and this file
carries the state. A ticked box therefore means shipped — not "shipped and acknowledged" — and an item
staying open here is not evidence that nobody looked at it.

---

## Review pass over both 2026-08-18 rounds

The three review agents were run over the two rounds above and found twelve defects, all of them in the
new code. Recorded because two are repeats of things this file already documents.

- [x] **The reason picker's Delete would have silently done nothing** under `prefers-reduced-motion`.
      The popover closed in the submit button's own click handler, so the portaled form was torn down
      before the browser ran the activation behaviour — the exact defect `ConfirmSubmit.svelte` carries a
      written note against, and which was reported in the previous round as "comment deletion silently
      cancels". It only worked because the exit animation deferred the unmount. Closing happens in the
      `enhance` callback now.
- [x] **The appeal queue still had the mass-action trap** the round set out to fix: only the review and
      reported cards lost their per-card verdict buttons while selected, so selecting twenty appeals and
      pressing Approve on one card resolved that one and left nineteen open.
- [x] **The new `setRating` was unguarded**, against the precedent in Front Page Audit's own action:
      `updateImageNsfwLevel` throws bare errors, and uncaught that replaces the queue with an error page
      and loses the record of what was already actioned. The bulk path now also names which ids failed
      rather than reporting a partial batch as success.
- [x] **`setFlag` accepted malformed input and cleared the flag.** It hand-split `flag:value` where the
      three sibling actions use `z.enum`, so `minor` with no colon resolved to *false*. The protocol
      moved to `$lib/image-flags.ts` and all four actions plus the three pickers use it.
- [x] **The bulk bar's rating and flag controls showed invented state** — `nsfwLevel=0, minor=false` for a
      mixed selection, so clearing a flag across a batch took two clicks, the first a no-op write. A
      `null` now means "mixed", rendering explicit Set/Clear pairs and no active rating chip.
- [x] **The bulk reason picker kept its violation type across selections** (its neighbour was keyed and it
      was not), so a reason chosen for one batch was posted with the next.
- [x] **`Images to Ingest` is `informational`** — the page has no actions and the count is upload
      throughput, so summing it into the Images badge reads as a review backlog whenever the scanner
      stalls.
- [x] **The Most reported rewrite evaluated its seventeen subplans below the sort**, i.e. for every
      qualifying report rather than the twenty kept — Postgres cannot project through a `Sort`, and the
      comment claimed the opposite. The LIMIT is taken in a CTE and the ids resolved outside it.
- [x] **The "Recently worked" window could be filled by one bulk action.** `ModActivity` is one row per
      entity and bulk removals write thousands, which would collapse the panel to that single action and
      drop precisely the least-recently-worked rows it exists to surface. Window widened to 20,000,
      automated writers excluded, and the whole call bounded so the board renders without it.
- [x] **Refusals were invisible** on the image queues — the page never rendered `form`, so a rejected
      rating or flag looked like a mis-click.
- [x] **Rating chips are gone from the appeal queue.** Those images are `Blocked`; setting a level there
      wrote `nsfwLevelLocked` over a state the appeal decision is about to replace. (It did not
      re-expose anything — feeds gate on `ingestion`.)
- [x] **Bulk Image Manager's gallery predicate was an `OR` across two tables**, which cannot become a
      semi-join, so it fell back to a per-row subplan over all of `Image` — run twice, for the rows and
      the count. It is a `UNION` of two id sets now, each driving its own index.

Taken while there, from the abstraction pass: `isRatingLevel` deduplicated (`$lib/nsfw-levels.ts`), the
violation input schema shared by all four removal actions, `bounded` promoted to `$lib/server/bounded.ts`
now it has a second caller, the ingestion-error predicate shared between its queue and its badge, the
dashboard's four hand-copied service types derived via `Jsonified`, and both new components moved beside
the route that owns them (they hardcode `?/setRating`, so they were page-local by construction).

Both items this section first listed as "not done" were then done:

- [x] **`reportEntityJoin` and `REPORT_SOURCES` are one map** (`report-entities.ts`), carrying table, fk,
      owning table, owner column and label per type. Two hand-spliced arms fall out of it: Chat in
      `getReportsReceived` (it existed only because Chat owns by `ownerId`, now a column on the row) and
      User in `getReportsSubmitted` and the board (the type whose `ownerColumn` is null). Two visible
      consequences, both deliberate: User Lookup's reported-content labels now agree with every other
      report surface, and reported **chats** appear in those counts — they were absent only because the
      old list could not express `ownerId`.
- [x] **`images/[slug]/+page.svelte` split** into `QueueHeader`, `QueueSelectionBar`, `ReviewActions`,
      `AppealActions` and `VerdictBadge`; 621 lines to 380. The page keeps the four `data.kind` branches,
      whose card bodies depend on that narrowing. No behaviour change.

Still open, and a product call rather than a defect: **Downleveled has no badge.** The ClickHouse log
only grows, but "downleveled and not yet ruled on" IS derivable — join `Image` and exclude
`nsfwLevelLocked`. It needs a decision on the predicate, not new infrastructure.

Also open: **queue-level granularity in "Recently worked"**. The options are to leave it at kind-of-work,
to have this app write a richer row to the moderator database it already owns, or to add a column to the
shared `ModActivity` (main-app coordination plus a migration).

## Round 2026-08-18 (second batch) — the board and the links

Seven reports. Five were the same underlying thing twice over: a panel or a link that only knows about
the `Report` table, and so is blind to every queue that resolves no report.

- [x] **Working Image Ratings never showed in "Recently worked" — and every image queue logged as
      "Reported images" only.** The panel read `Report.statusSetBy` alone, so a queue that closes no
      report appeared nowhere and the one that does appeared as its report type. It now also reads
      `ModActivity`, the log every queue in this app writes, grouped by (entityType, activity) —
      "Image reviews", "Image ratings", "Image appeals", "Image minor flags". Report rows are relabelled
      "<Type> reports" so the two sources are told apart.
      - The granularity stops at the kind of work, not the individual queue: which queue an image review
        came from is `needsReview`, which the action clears. Finer rows would mean writing the queue
        into `ModActivity.activity`, whose values are a contract shared with the main app.
      - Bounded to the newest 2,000 rows (an index scan on `ModActivity_createdAt_idx`) rather than a
        date window, which would sort every row in it. An activity absent from that window is one nobody
        has worked recently — the same answer the panel would give.
      - Retool logged every rating change on the whole site, which is the opposite failure: a feed, not
        a board. This is deliberately the middle.
- [x] **Urgent content was missing hyperlinks, and chat reports did not link at all.** One cause: *Most
      reported* joined five of the fifteen report tables (image, model, post, article, user). The other
      ten — chat, comment, commentV2, bounty, bounty entry, collection, resource review, comic, 3D model,
      3D review — fell through to `other` with a null id, so they rendered as unidentified grey text.
      All fifteen are now resolved from `reportEntityJoin`, and the table uses `getReportItemUrl` (the
      helper the reports queue already used) rather than bare `entityUrl`: a chat goes to its Chat Audit
      transcript, and a comment to its deep link with the row highlighted.
- [x] **Bulk Image Manager showed only showcase images for a model version.** `getImagesForModelVersion`
      selected images by `Post.modelVersionId` — that is the creator's own posts to the version. The
      gallery joins through `ImageResourceNew`, which is what the main app's gallery filters on and where
      reportable content actually accumulates. Both sets are now returned, for the model-wide source too.
- [x] **Ingestion Errors and Images to Ingest showed no counts anywhere.** Neither nav entry had a
      `countKey` and the errors queue had no count function at all. Both now badge, on the sidebar and
      the dashboard, using each queue's own predicates so a drained queue reaches zero.
      - The two counts are wrapped in a timeout: they run inside the one `Promise.all` every navigation
        waits on, and `Image.ingestion` has no index of its own. On timeout the key is omitted.
      - Fixed while here: the dashboard turned a **missing** count into `0`, which both reads as "empty"
        and hides the row under the quiet-queue filter. An unmeasurable count now renders as no number,
        the way the sidebar already did.
      - Downleveled is deliberately still uncounted: it is a ClickHouse log that only grows, so a badge
        on it would never fall.
- **User Lookup unavailable for the staff role.** Not a defect — it is the `/admin` grant still
      outstanding in [`permissions-handoff.md`](permissions-handoff.md). Nothing to build.

## Round 2026-08-18 — the image queues are a review screen, not an action screen

Five reports, four of them one complaint: the card shows you the image and offers a verdict, and every
other moderation decision — the rating, the minor flag, the reason a removal is filed under — needed a
second window. Closed together, since they are the same missing control set.

- [x] **Ratings could not be changed from a queue.** Every card now carries the five rating buttons,
      posting the same `updateImageNsfwLevel` the Ratings queue uses (which locks the level, so a later
      Accept's recompute leaves it alone). Rating does not clear `needsReview` — it is a correction, and
      the image still has to be accepted or removed.
- [x] **The minor flag was not on the image.** Minor and POI toggles now sit beside the rating, both
      directions, on every image queue. Same `/api/mod/update-image-flag` path Image Lookup already used.
- [x] **Removing an image recorded no reason.** Delete now opens the violation list (the main app's
      `TOS_REASONS` wording) plus an optional details box, and both ride to the ClickHouse `DeleteTOS`
      event. The plumbing already accepted `violationType`/`violationDetails` and nothing passed them, so
      every removal from these queues was filed as whatever the queue implied. The chosen violation is
      also what the appeal queue shows the next reviewer as the reason for removal.
      - [x] The user-facing notification now carries the reason too. `details.reason` is optional at
            every layer and the processor keeps the old wording without it, so the backlog is unaffected.
            Only the moderator's own choice is sent — the inferred fallback stays in analytics.
            **Needs the main-app deploy this handover is already blocked on**; until then the spoke
            sends a field the processor ignores, which is harmless.
- [x] **Selecting several images and pressing Accept on one accepted only that one.** The bulk bar
      existed; it was findable only after selecting something, and the per-card buttons stayed live
      underneath. A selected card now loses its own verdict buttons and says where they went, the bulk
      labels carry the count ("Accept 12"), Delete in the bar takes the same reason picker, and a
      **Select all N** control sits with the filters — a batch was fifty clicks to assemble.
- [x] **"Urgent Content is missing."** It is not — and the reporter's own hedge was right. *Most reported*
      is that data; the banner above it counts the same rows at `URGENT_REPORT_COUNT`+ reports. Nothing to
      build, so the two were made legibly the same thing: the section says so, and rows at or above the
      threshold now carry a red count instead of a grey one.

Not verified in a browser — the changes typecheck and the actions are the ones the neighbouring pages
already use, but nobody has worked a queue with them yet.

## Context that set the ordering

Retool was scheduled to shut down **2026-08-18**, so anything blocking parity outranked anything
improving on it. Between the 08-14 release and 08-17 no commits landed on `apps/moderator`, so every item
reported on 08-16 and 08-17 starts from untouched.

## P0 — blocking, needed before the Retool shutdown

- [x] **A post detail view on Image Lookup.** Raised 08-17 as a question about repointing a link, and the
      link half of it turned out to be exactly that — see the repoint item below; "Lookup Post" targets
      Retool's Bulk Image Manager, which is ported and needs no code. What was genuinely absent is the
      post *itself*: publish state, availability, ToS, author. `?post=<id>` on Image Lookup, or a pasted
      post URL, now shows it above the post's images, and hands off to Bulk Image Manager to act on them.
      **Deliberately not a new route** — a new page has no `AppPageAccess` row and would be invisible to
      everyone but `moderator:admin` until granted on `/admin`, the bottleneck already holding up the
      items below. On Image Lookup it inherits an existing grant and needs no admin action.
      - [x] Fixed while here: pasting a post URL into Image Lookup resolved it as an *image* id, because
            the resolver took the last URL segment and `/posts/12345` ends in digits. It returned image
            12345 — a real, unrelated row — presented as the thing that was pasted. Silent wrong-content,
            no error.
- [x] **Repoint the two main-app lookup buttons at Bulk Image Manager.** Both `NEXT_PUBLIC_POST_LOOKUP_URL`
      and `NEXT_PUBLIC_MODEL_LOOKUP_URL` target Retool's Bulk Image Manager, which accepts
      `urlparams.postId` / `modelId` / `modelVersionId` / `collectionId` / `userId` — "lookup post opens
      all the images in Retool" is that app, not a separate one. It is exported, ported, and already
      supports both entry points, so this is the config change it was first reported as:
      - `NEXT_PUBLIC_POST_LOOKUP_URL` → `<moderator app>/retool/bulk-image-manager?source=post&q=`
      - `NEXT_PUBLIC_MODEL_LOOKUP_URL` → `<moderator app>/retool/bulk-image-manager?source=model&q=`

      **An earlier revision of this file claimed Post Lookup and Model Lookup were un-exported Retool apps
      and that the inventory was therefore incomplete. That was wrong** — no such apps exist; the names
      were inferred from the main app's button labels and never checked against Retool's app list, which
      does not contain them. The four moderator entry points in
      [`client-schema.ts`](../../src/env/client-schema.ts) all resolve to exported, ported apps:
      user → User Lookup, chat → Chat Audit, post and model → Bulk Image Manager.

      The tracker genuinely did list 9 of 13 subtasks, and sections 1.4 and 1.10 are still absent from
      [`retool-migration-tasks.md`](retool-migration-tasks.md) — but subtasks are not apps, and nothing
      now suggests an unported one.
- **Repoint the four lookup env vars off Retool** — handover blocker
      [5b](retool-migration-handover.md). Config only; both post and model target Bulk Image Manager,
      which is already ported.
- **Finish the environment and database steps** — handover blockers
      [#1–#4](retool-migration-handover.md). What is actually outstanding is narrower than that list
      reads; see [§ Environment status](#environment-status) below.
- [x] **Ship the dependent main-app deploy.** Shipped (confirmed 08-19). `origin/main` carries the
      moderator endpoints the spoke calls, and the 08-19 round contains a strike that ISSUED rather than
      erroring — the symptom this item predicted, now gone. Its successor is a strike that issues but does
      not display, in the [2026-08-19 round](mod-studio-feedback-2026-08-19.md).

**Permission grants have moved** to [`permissions-handoff.md`](permissions-handoff.md) — re-enabling
User Lookup, granting the five newer pages, Chat Audit access, and confirming the sub-permission
defaults. They are `/admin` changes with a different owner, and mixing them into an engineering list
made the list read as if it were all dev work.

**Retool re-extraction is not being done**, and does not need to be: every app the moderator entry
points reach is already exported and ported. The one thing it would have settled is Front Page Audit's
rating vocabulary — the older exports predate the extractor learning option sets (08-07) and layout
(08-08), so that stays unconfirmed and will have to be read off the built page or decided fresh.

### Environment status

Checked against `apps/moderator/.env` on 2026-08-17. Deployed environments are separate and still need
verifying individually.

| Item | Local state | Note |
| --- | --- | --- |
| `CIVITAI_MOD_API_KEY` | **retired 08-19** | **Do NOT provision.** The spoke authenticates as the acting moderator instead; nothing reads this variable and it is gone from the code and from `.env.example` |
| `RETOOL_DATABASE_URL` | set | Needs confirming in every deployed env — without it notes/strikes/mutes read the wrong database |
| 3 SQL migrations | see below | Each is `CREATE INDEX CONCURRENTLY`, so each runs outside a transaction |

- `20260803120000_add_app_page_access` — **almost certainly already applied**: `/admin` grants
  demonstrably work in production (a page was toggled off there on 08-13), which this table backs.
- `20260805120000_mod_activity_append_only` — verify. Without it repeat mod actions collapse into one
  row, so moderation history reads as thinner than it is.
- `20260807120000_report_open_reason_index` — verify. Without it the Reports sub-nav count seq-scans
  ~2.4M rows on every navigation.

## P1 — reported defects, not yet triaged by a dev

- [x] **Comment deletion silently cancels — the confirm button behaved like cancel.** Fixed in
      `ConfirmSubmit.svelte`. The confirm button was `type="submit"` and also cleared `confirming` in its
      own click handler; Svelte flushes effects synchronously after a DOM event handler, so the `{#if}`
      unmounted the submitter before the browser ran the form's activation behaviour. The submit never
      fired, so no request was made and no error could be shown. It now closes when the write completes.
      - Not the missing API key, which an earlier draft of this file blamed. That path returns a
        `contentFail`, and `CommentsPanel` renders it in a red box — the reporter saw **no error at all**,
        which is what placed the failure before the request rather than in it.
      - [x] **Bulk review deletion had the identical defect** and nobody reported it — same component, one
            of five call sites. Fixed by the same change.
- [x] The report detail overlay stayed mounted after "unaction", leaving the page blurred and stuck.
      Already fixed in `66d14f8d96` (08-13, v0.0.23), after the 08-12 report. The sheet's openness is now
      derived from whether there is a report to show, rather than an independent `open` flag: a status
      change invalidates and the row leaves the queue, so the flag stayed true over a body that rendered
      nothing.
- [x] **Comments now link to the comment itself**, not just its entity. Two systems, two shapes, neither
      derivable from `entityUrl`: legacy model comments open the thread dialog with the row highlighted
      (`?dialog=commentThread&highlight=`), and `CommentV2` goes through the main app's
      `/comments/v2/<id>` resolver, which redirects with the comment pinned. The resolver also fixes two
      cases a built URL cannot reach — entity types with no standalone page (previously unlinked grey
      text) and replies past the first page of a long thread.
      - The same report mentioned the comment rows being "funky" to read. Not addressed — it was a
            screenshot, and the layout complaint isn't reconstructable from the text.
- [x] **Bulk Image Manager showed at most 200 images with no way to page further.** A size control now
      offers 200 / 500 / 1000, carried in the URL as `limit` so a batch stays shareable, and preserved
      across a new search rather than snapping back. The 08-13 remove-every-image-on-this-account button
      addressed a different need — this was about *seeing* past 200, and the only route to the rest was an
      account-wide purge, which is not a review.
      Past 1000 the purge remains the answer; the truncation banner now says so.
- `reportedUser` renders greyed out on reports. Suspected downstream of User Lookup being disabled —
      confirm it clears when that is re-enabled, otherwise it is its own defect. **Blocked on the `/admin`
      re-enable in P0**, not investigable before it.
- [x] **Comics review → block returned a 500.** The action `await`ed the moderation call unguarded, so
      anything it threw rendered a 500 page instead of a refusal — against this app's own rule, and it
      unmounts the queue being worked. It now returns `fail`, and the page renders errors at all, which it
      previously did not.
      - [x] **The worse half, unreported:** the panel was marked "Blocked" optimistically and **never
            reverted on failure**. On the exact 500 that was reported, the card showed a verdict, the
            panel was untouched, and the moderator moved on. See the sweep below.
      - Not addressed: why banned users' comics are queued for review at all. Raised as a possible
            better fix; it is a queue-predicate question, not this defect.
- [x] **Deleting an image returned a 500 but succeeded.** Closed by `fix(moderator): don't fail a
      moderation action on its side effects` (08-12) — `blockImage` ran five side effects, three of which
      could reject out of the form action after the write had already landed, so the moderator got a 500
      for completed work and the natural response, retrying, was the worst available. That commit names
      this as the mechanism.
- [x] **Bulk Image Manager returned the user to the dashboard mid-task — not a navigation bug.** It is the
      route gate in `hooks.server.ts`: a page the account has no grant for 303s to `/`. Browser-back
      "working" was the tell — the previous page was one they *could* reach. It was indistinguishable from
      breakage because the bounce was silent; it now says which path was refused and that an admin grants
      it on the Permissions page. The underlying grant is still a P0 `/admin` action.

### Found while working the round, not reported

- [x] **Optimistic marks never reverted on failure, across four more queues.** The same defect as Comics
      Review, in `images/downleveled`, `images/ratings`, and both handlers in `images/[slug]` — the queue
      hub behind `/images/csam` and `/images/minor`, where a bulk action marked the whole batch handled
      whatever the server answered. `models/minor-hash-matches` and `front-page-audit` already guarded it
      and carry comments saying why, so the rule was known and unevenly applied. All now revert.
      This is the app's stated non-negotiable — "a dim applied before the server answers and never undone
      makes the operator's own record wrong, and the item they skip is the one that failed."

## P2 — decisions, not implementation

These block work below them and cannot be resolved by writing code.

- **`ReToolActions` vs `ModActivity`** — two mod-action logs that nothing reconciles. A recommendation
      exists (2026-08-11): migrate as a read-only archive, do **not** merge, because the user id is embedded
      in free text and matched with `LIKE`, so merging would invent attribution that later reads as real.
      See [`retool-db-cutover.md`](retool-db-cutover.md). Needs a yes.
- **Two strike systems** — this app writes the Retool-era `UserStrikes`, not the main app's newer
      `Strike`.
- **`aiNsfwLevel` / `aiModel` exist in production but not in `schema.full.prisma`** — add them to the
      schema, or accept the raw `sql` read.
- **`FrontPageTimers` / `RatingChanges`** — the two schemas Front Page Audit needs before it can resume
      or log. The sweep works without them; the shared resume point and the audit trail do not.
- **Confirm the sub-permission defaults** shipped on 08-14: buzz send and email edit as senior-only,
      granting cosmetics as admin-only. The last was chosen to match Retool and has not been confirmed.
- **How queue sweeps get tracked** — a new table, or an extension of `ModActivity`. Blocks the
      remaining queue requests below.

## P3 — improvements, after parity

Parity comes first; these are recorded so they are not lost. Items here that Retool never had should move
to [`post-migration-backlog.md`](post-migration-backlog.md) once confirmed.

### User Reports

- [x] Queue column narrowed from `w-120` to `w-96`
- [x] Action / Dismiss / Claim moved inline with the "reported by" line — each report was spending a
      whole row on the controls plus dead space either side of them
- [x] **Setting a report to Processing already existed** — the "Claim" button, since `47df60c16f`
      (08-07), a week before it was reported missing. Nothing to build; it was a naming gap, since the
      other two buttons are named for their verb and this one for its gesture. It now says what status
      it sets on hover.
- [x] Queue filtering by status, reporter and filed-on date. Status uses the repo's URL-filter
      convention — absent `?status=` is the Pending+Processing default that matches the sidebar badge,
      a present-but-empty one is a deliberate "every status". Date support was added to `getReports`,
      which had none.
      - The date params are `reportedFrom` / `reportedTo`, **not** `from` / `to`: those were already
        taken by the suspect image filters on the same page, and reusing them would have silently
        re-filtered the account's images every time the queue was narrowed.
      - The panel heading claims parity with the sidebar count, which is only true unfiltered — it now
        says so only while it is true.
- [x] Account images made denser — `ImageQueueGrid` takes a `minColumn`, defaulting to the 300px every
      full-width queue standardised on, and this grid passes 200. It is the one image grid rendered
      beside another column, where 300 yields three cards a row. The standard is unchanged everywhere
      else.

### Dashboard

- [x] "Most Reported" leads the page — it is above the queue board, on the reasoning that a pile-up on
      one item is a live incident while the counts are a backlog
- [x] Reporter count per item — the table's first column
- **Show "recently worked" and "time sweeps" beside the queues they describe.** Both render, but as
      their own panels rather than per queue row, and that is deliberate: **the report-source labels and
      the sidebar's count keys are named independently, and three of them do not correspond**, so there
      is no key to attach a row to. Blocked on the same P2 decision the requester raised in the same
      breath — a table to track queues, or a revision of `ModActivity`. Not attemptable before it.

### Queues

- [x] Articles and bounties timestamp sweeps — 08-13
- [x] The three minor-hash-match queues — 08-13
- [x] Unpublished models where the author requested review — `getModelsNeedingReview`, the requested
      predicate exactly (`UnpublishedViolation` + `meta->>'needsReview'`). Client-fetched on the
      dashboard because the count has no index and runs ~2.7s.
- [x] Models transferred to Civitai on account deletion — the `civitaiModels` sweep, which is Retool's
      `CivitModelsData`: what `userId = -1` has published since the last claim
- [x] Drop unpublished articles as a queue — already `informational: true`, which keeps its count out of
      the dashboard's "needs attention" total. The flag's own comment names this case. The page stays
      reachable for lookup; it just stops presenting as work.
- [x] Surface high-report-count content on the dashboard — the Most Reported table, with links and
      inline resolve. The 08-13 urgent banner points at it rather than replacing it.

### User Lookup

- [x] Open-reports banner trimmed to the count — `66d14f8d96`, 08-13. The moderator who filed stays as a
      chip rather than prose, since that is the anti-overlap signal the banner exists for.
- [x] "Spoke with a mod" chip is red like a ban — same commit
- [x] `name` from the user table — shown as "Full name"
- [x] Subscription moved onto Basic. Moved rather than duplicated: a second copy of a panel that can
      re-link a Paddle customer is two places to fix a bug in.
- [x] Creator-program membership, including the banned-from-it state
- [x] Timed Mutes holds only timed mutes
- [x] **Socials folded into Basic and the tab retired.** Once avatar, bio and location moved onto Basic,
      the tab held nothing but a link list. The slug still resolves and redirects, so lookup URLs already
      pasted into tickets do not 404.
- [x] Copy-all-unique-IDs in addresses and linked accounts, plus a direct "check these in Bulk Ban" —
      the panel identifies a ring and Bulk Ban deals with it; the ids in between were reachable one row
      at a time

### Cross-cutting

- [x] **Removal options mirror the site** on the multi-select removal UIs — Bulk Image Manager and User
      Reports both offer `VIOLATION_TYPES`, which matches the main app's `ViolationType` enum entry for
      entry, alongside the canned reasons.
      - The `/images/*` triage queues are **not** included, and this is a decision rather than an
            oversight. Their bulk block goes through `blockImage` — the report-driven path, shared with
            Comics Review — not `removeImages`, which is what carries a violation type. Giving them the
            reason list means moving them onto a different endpoint with different side effects and a
            different audit trail. Worth doing deliberately, not as a UI tweak.
- **Link a report to the site it originated from — not implementable here.** `Report` has no origin
      column, and `createReport` writes only `reportType` into `details`, so the fact is never recorded
      anywhere. It needs a main-app change to capture the host at report time before this app can show
      it. The reporter filed it as a "for future" ask, which is the right classification.

### Product questions — none of these are moderator-app work

Recorded here because they were raised in this channel, but each is a main-app change, a policy call, or
both. None can be closed by this app.

- The "Admin Attention" report reason is too vague to action — remove it or merge it. Changes the
      main app's `ReportReason` and what reporters are offered; the requester also flagged an unknown,
      whether it still matters to the guardian score.
- The mod changelog modal disappears once a model is unpublished, so the changes and the unpublish
      reason become unreadable exactly when they matter most. Main-app model page.
- Unpublished articles have no republish path; authors are told to contact support and the article
      page does not even say that. Main app plus a support-process decision.
- A model marked as depicting a minor can still receive a new version containing X-rated images.
      Main-app filtering behaviour, reported here only because it surfaced during moderation.

---

## Shipped

Confirmed in the channel by the people who reported them.

**08-12 (v0.0.19/v0.0.20)** — Report-queue counts corrected. Every Retool report query filtered out
`Automated` reports and the port dropped that filter, so classifier output was counted as human backlog
across every queue; the badges were wrong by several orders of magnitude and every queue page showed the
system account as the only reporter. Human-filed reports are now counted, with a toggle for automated ones.
Also: content links stopped falling back to the public domain; chat reports link to their transcript;
membership shows on basic user information; avatar and cover images render inline for ToS checks; content
rows link into the app rather than the public profile, which had been hiding deleted and unpublished items;
review and comment text renders; Retool-era history is visible under moderator activity; bulk review and
comment deletion confirms before firing.

**08-13 (v0.0.21–v0.0.23)** — Bulk Image Manager: filter by rating, ToS'd-only and hide-removed; prompt
search including negative prompts; honest counts when re-removing an already-blocked batch; remove-all-on-
account behind a typed username. ToS removal can strike the owner in the same action, sending the chosen
canned reason. Minor hash matches ported under a new Models section, all three tabs with counts and paging.
Clicking an image selects it, with a corner control to open it. User Reports: clicking anywhere opens the
report, the username opens User Lookup, and prior mod activity and human-filed reports show beside the
notes. The article and bounty timestamp queue sweeps render. Report queues gained a details column
carrying the reporter's own words. User Lookup: payouts,
training parameters, notes and strikes on basic information, the CSAM chip opens its report, Paddle customer
re-linking, quick-info checkboxes, and chat links that no longer 404. Bulk Ban took the full list of
requests from that round. Dashboard gained an urgent-content banner.

**08-14 (v0.0.24–v0.0.26)** — Sub-permissions: individual actions inside a page can be gated, granted per
role on the permissions page, and a capability now honours every page it requires rather than only its own.
**Superseded 08-19:** that last clause was the defect, not the feature — requiring the page meant an
ungranted `/users` silently zeroed five permissions and made them ungrantable. Page grants and action
grants are independent now (`e14a5428dd`); the rest of the entry still stands.
`/admin` reads its role columns from the auth hub, so a role created there gets a column without a deploy,
and its refusals stay visible instead of being hidden behind the unsaved-changes line.

**08-10** — Page access widened for a moderator who could not reach the dashboard.
