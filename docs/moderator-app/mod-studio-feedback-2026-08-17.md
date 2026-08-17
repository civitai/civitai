# Mod Studio feedback — running checklist

The moderation team reviews the app in a feedback channel and reports as they go. This file is the single
place to see what they asked for and whether it is done, so the state does not have to live in code
comments or in a chat scrollback.

**Scope:** everything reported between 2026-08-05 and 2026-08-17.

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

**Items are not announced back to the reporters individually.** Replying per item as things land adds
noise for a team who mostly want the tool to work, so release notes carry what changed and this file
carries the state. A ticked box therefore means shipped — not "shipped and acknowledged" — and an item
staying open here is not evidence that nobody looked at it.

---

## Context that set the ordering

Retool was scheduled to shut down **2026-08-18**, so anything blocking parity outranked anything
improving on it. Between the 08-14 release and 08-17 no commits landed on `apps/moderator`, so every item
reported on 08-16 and 08-17 starts from untouched.

## P0 — blocking, needed before the Retool shutdown

- [x] **Post Lookup now works in the mod app.** Raised 08-17 as a question about repointing a link; it was
      missing functionality. The main app's "Lookup Post" control
      ([`PostControls.tsx`](../../src/components/Post/Detail/PostControls.tsx)) opens
      `NEXT_PUBLIC_POST_LOOKUP_URL` + the post id, and that pointed at a **Retool app that was never
      exported and appears in no migration inventory** — Retool's own Image Lookup takes only an Image Id
      or Image URL, so nothing here could have received the link. It would have broken outright at the
      cutoff. Post support now lives on Image Lookup: `?post=<id>`, or a pasted post URL, renders the post
      with its author, rating, publish/ToS/availability state and every image in author order, each
      linking to its own full detail.
      **Deliberately not a new route** — a new page has no `AppPageAccess` row and would be invisible to
      everyone but `moderator:admin` until granted on `/admin`, which is the exact bottleneck already
      holding up the items below. On Image Lookup it inherits an existing grant and needs no admin action.
      - [ ] **Remaining step, ops:** repoint `NEXT_PUBLIC_POST_LOOKUP_URL` at
            `<moderator app>/retool/image-lookup?post=` — the control appends the raw post id.
      - [x] Fixed while here: pasting a post URL into Image Lookup resolved it as an *image* id, because
            the resolver took the last URL segment and `/posts/12345` ends in digits. It returned image
            12345 — a real, unrelated row — presented as the thing that was pasted. Silent wrong-content,
            no error.
- [ ] **Enumerate Retool's actual app list before access ends — the export inventory is incomplete.**
      Not a refresh of known exports; a search for apps nobody has recorded. The inventory was built from
      *the ClickUp subtasks of `868kkxqpn`, one per app* ([exports
      README](retool-exports/README.md)), so it only ever contained what was ticketed — and the handover
      already notes the tracker listed **9 of the parent ticket's 13 subtasks**. Two moderator-facing
      Retool apps are now confirmed absent from it, both found by accident:
      - **Post Lookup** — replacement built 08-17, see below.
      - **Model Lookup** — live and moderator-gated in the main app
        ([`ModelCardContextMenu.tsx`](../../src/components/Cards/ModelCardContextMenu.tsx),
        [`TopRightIcons.tsx`](../../src/components/ImageGeneration/GenerationForm/ResourceSelectModal/TopRightIcons.tsx)),
        referred to by a moderator on 08-05 as a tool they use, and mentioned in **no** migration
        document. **No replacement exists and none is planned.** It breaks at the cutoff.

      Of the four moderator lookup entry points in the main app
      ([`client-schema.ts`](../../src/env/client-schema.ts)), user and chat map to exported apps
      (`user-lookup-v2`, `chat-audit`); post and model do not. Both gaps were found by following links
      outward from the main app rather than inward from the tracker — **that direction has not been swept
      systematically, and it is the only direction that finds an app nobody ticketed.**

      After the cutoff an un-enumerated app is not stale, it is unrecoverable.
- [ ] **Re-extract every Retool export while access remains** — handover
      [#11](retool-migration-handover.md). The extractor only learned option sets on 08-07 and layout on
      08-08, so older exports lack tab labels, canned workflows, role gates and pane structure. It is also
      the only way to confirm Front Page Audit's rating vocabulary. **Irreversible once access ends.**
- [ ] **Complete the environment and database steps** — handover blockers
      [#1–#4](retool-migration-handover.md). One reported defect is configuration rather than code:
      striking refuses up front. It resolves with the environment set; verify it afterwards rather than
      debugging the UI.
- [ ] **Re-enable User Lookup.** It was switched off on 08-13 pending sub-permissions, which shipped on
      08-14. Still off as of 08-17, and it is the most used page in the app.
- [ ] **Grant the five newer pages on `/admin`** — handover [#5](retool-migration-handover.md). A page is
      restricted until granted, which is why chat-audit reads as missing for some moderators, and why chat
      report links look broken to them after those links were fixed on 08-12.
- [ ] **Ship the dependent main-app deploy.** Flagged as blocking in three separate releases. Until it goes
      out, issue/void strike, timed-mute expiry, overturn/uphold on pending restrictions, and the
      minor-hash-match buttons all error.

- [ ] **Grant the dev working these tickets access to the auth hub's role admin.** They are currently
      refused on that page, so they cannot verify their own permissions work.

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
      - [ ] The same report mentioned the comment rows being "funky" to read. Not addressed — it was a
            screenshot, and the layout complaint isn't reconstructable from the text.
- [x] **Bulk Image Manager showed at most 200 images with no way to page further.** A size control now
      offers 200 / 500 / 1000, carried in the URL as `limit` so a batch stays shareable, and preserved
      across a new search rather than snapping back. The 08-13 remove-every-image-on-this-account button
      addressed a different need — this was about *seeing* past 200, and the only route to the rest was an
      account-wide purge, which is not a review.
      Past 1000 the purge remains the answer; the truncation banner now says so.
- [ ] `reportedUser` renders greyed out on reports. Suspected downstream of User Lookup being disabled —
      confirm it clears when that is re-enabled, otherwise it is its own defect. **Blocked on the `/admin`
      re-enable in P0**, not investigable before it.
- [x] **Comics review → block returned a 500.** The action `await`ed the moderation call unguarded, so
      anything it threw rendered a 500 page instead of a refusal — against this app's own rule, and it
      unmounts the queue being worked. It now returns `fail`, and the page renders errors at all, which it
      previously did not.
      - [x] **The worse half, unreported:** the panel was marked "Blocked" optimistically and **never
            reverted on failure**. On the exact 500 that was reported, the card showed a verdict, the
            panel was untouched, and the moderator moved on. See the sweep below.
      - [ ] Not addressed: why banned users' comics are queued for review at all. Raised as a possible
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

- [ ] **`ReToolActions` vs `ModActivity`** — two mod-action logs that nothing reconciles. A recommendation
      exists (2026-08-11): migrate as a read-only archive, do **not** merge, because the user id is embedded
      in free text and matched with `LIKE`, so merging would invent attribution that later reads as real.
      See [`retool-db-cutover.md`](retool-db-cutover.md). Needs a yes.
- [ ] **Two strike systems** — this app writes the Retool-era `UserStrikes`, not the main app's newer
      `Strike`.
- [ ] **`aiNsfwLevel` / `aiModel` exist in production but not in `schema.full.prisma`** — add them to the
      schema, or accept the raw `sql` read.
- [ ] **`FrontPageTimers` / `RatingChanges`** — the two schemas Front Page Audit needs before it can resume
      or log. The sweep works without them; the shared resume point and the audit trail do not.
- [ ] **Confirm the sub-permission defaults** shipped on 08-14: buzz send and email edit as senior-only,
      granting cosmetics as admin-only. The last was chosen to match Retool and has not been confirmed.
- [ ] **How queue sweeps get tracked** — a new table, or an extension of `ModActivity`. Blocks the
      remaining queue requests below.

## P3 — improvements, after parity

Parity comes first; these are recorded so they are not lost. Items here that Retool never had should move
to [`post-migration-backlog.md`](post-migration-backlog.md) once confirmed.

### User Reports

- [ ] Open-reports column occupies roughly half the viewport; shrink it substantially
- [ ] Put action/dismiss inline with the "reported by" line to cut dead space
- [ ] No way to set a report to "processing" — only action and unaction
- [ ] No filtering by status, user or date
- [ ] Account images: expand the section and shrink the thumbnails; currently 3–4 per row against more in
      Retool, which compounds on large accounts

### Dashboard

- [ ] Move "Most Reported" to the top of the page
- [ ] Show the number of distinct reporters per item
- [ ] Show "recently worked" and "time sweeps" beside the queues they describe

### Queues

- [x] Articles and bounties timestamp sweeps — 08-13
- [x] The three minor-hash-match queues — 08-13
- [ ] Unpublished models where the author requested review
- [ ] Models transferred to Civitai on account deletion, published, since last check
- [ ] Drop unpublished articles as a queue — raised twice, 08-05 and 08-13. There is no review path for
      republishing them, and most are spam that should never be republished
- [ ] Surface high-report-count content on the dashboard — partially served by the 08-13 urgent-content
      banner; the request was a table with links and inline actions. See
      [§12c](retool-parity-checklist.md#12c-dashboard)

### User Lookup

- [ ] Trim the open-reports banner to the count alone; drop the trailing "someone is already on this"
      phrasing added 08-12
- [ ] Render the "spoke with a mod" chip in the same red as bans
- [ ] Show `name` from the user table
- [ ] Move subscription status into basic information rather than the Buzz section
- [ ] Show creator-program membership
- [ ] Timed Mutes tab: remove everything that is not a timed mute
- [ ] Fold the socials tab into the space near location, now that profile fields render on basic info
- [ ] Add a copy-all-unique-IDs control in addresses and linked accounts, for the bulk ban tool

### Cross-cutting

- [ ] Mirror the site's own removal options in every multi-select removal UI
- [ ] Link a report to the site it originated from, rather than always the same domain

### Product questions

- [ ] The "Admin Attention" report reason is too vague to action — remove it or merge it into the others
- [ ] The mod changelog modal disappears once a model is unpublished, so the changes and the unpublish
      reason become unreadable at exactly the point they matter most
- [ ] Unpublished articles have no republish path; authors are told to contact support, and that is not
      stated on the article page
- [ ] A model marked as depicting a minor can still receive a new version containing X-rated images.
      Filtering behaviour rather than a mod-studio defect, but reported here

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
`/admin` reads its role columns from the auth hub, so a role created there gets a column without a deploy,
and its refusals stay visible instead of being hidden behind the unsaved-changes line.

**08-10** — Page access widened for a moderator who could not reach the dashboard.
