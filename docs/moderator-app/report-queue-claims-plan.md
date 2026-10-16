# Report queues: claims, skip, escalation — and Processing as "parked"

**Status:** plan, 2026-10-15. Claims, skip, escalation and the parking changes are not built; the page standard (§2) is done (45a3e3ca87). The body reflects every answer in §10. What is still open is listed at the top of §10.

Two pieces of work that turned out to be one:

1. **A standard for non-table report pages.** `/reports/user` and `/reports/model` were rebuilt as a
   queue layout with the open item in the path. More types will follow. Before that, the two pages
   need to agree on one shape (§2).
2. **Splitting `Processing`.** It is used for two things: "a moderator is on this", which it can't
   do (no owner, no expiry, blocks nobody), and "this is waiting on something", chiefly an ownership
   claim under investigation. The first moves to a live **claim**, with **skip** and **escalation**
   beside it. The second **stays Processing** — shown as parked, with a note and an age alert (§8).

---

## 1. What Processing does today

- **As a claim, nothing sets it any more.** New reports start Pending
  (`src/server/services/report.service.ts:270`, `:490`). The moderator app stopped claiming on
  2026-08-21 (`d489795468`). The 404 Processing user reports were all set more than 30 days ago.
- **As a hold, it is still in use.** Moderators set it on model reports while an ownership claim is
  investigated, which can take weeks (confirmed, §10 Q17). That's why the model queue still offers it.
  The report already has what a park needs — `internalNotes` for what is awaited, `statusSetAt` and
  `statusSetBy` for since when and by whom — but nothing shows them together, and nothing flags one
  left too long, so a live investigation looks the same as an abandoned claim.
- **It costs.** Every queue's default view is Pending + Processing, so the stale rows sit in every
  queue. The sidebar badge counts Pending only — which is why the badge and `/reports/user` disagreed.
- **It can't be a claim.** It has no owner and no expiry, so an abandoned claim is permanent. It
  doesn't block anyone. And it writes to the report itself, where status changes have side effects
  (Actioned pays the reporters).

---

## 2. The page standard (the base this builds on)

What `/reports/user` and `/reports/model` now share:

| | Standard |
|---|---|
| **Route** | `/reports/<type>` is a layout holding the queue. `/reports/<type>/<id>` (plus `/<tab>` where there are tabs) is a page holding the open item. |
| **Layout load** | The queue's rows, status counts and permissions. Reads the URL one parameter at a time, never the path, so moving between items doesn't rerun it. A test checks this. |
| **Page load** | Only the open item's own data. The bare path opens the queue's first item. |
| **URL** | Path: which item and which tab. Query string: only what was changed from the defaults — filters, the queue page, the item's own filters. Defaults are never written in. An empty `?status=` means every status. `?report=<id>` opens one report with the filters off. |
| **Screen** | Queue column (`ReportFilters`, striped list, Prev/Next), then the item across the rest. Every scrolling column is `relative`. |
| **Actions** | Exported by both pages, the bare one and `[id]`. |

What the parent session settled since this was first written (committed in 45a3e3ca87):

1. **Report status.** Both queues share `ReportStatusButtons`, which offers `REPORT_RULINGS`
   (Actioned/Unactioned) unless it is passed `statuses`. The user queue uses the default. The model
   queue passes all four (`reportStatuses`) and its server accepts all four, for now, on Briant's call,
   because Processing means "parked" — for example an ownership claim under investigation (§8). Setting
   Processing or Pending does not move the list on to the next report; only a ruling does.
   `reportStatusActions({ rulingsOnly: true })` is the server switch once that's settled.
2. **One queue loader.** Both layouts use `loadReportQueue`, with options for status counts, the
   reported-date range, canonicalizing defaults and page size.
3. **Paging** opens the new page's first item on both pages (Q15).
4. **What the path names:** the item, with **all its open reports** listed, loaded for the item rather
   than picked out of the queue page (Q16). Ruling on one opens the next; when none are left the page
   moves to the next item in the queue.
5. **Shared components** in `lib/components/report-queue/`: `ReportQueueShell`, `ReportQueueColumn`,
   `ReportDetailColumns`, `ReportList` (the compact report rows, which replaced `ReportSummary`) and
   `ReportStatusButtons`. The whole pattern is written up in
   [`report-queue-pattern.md`](report-queue-pattern.md).
6. **Form errors:** each form holds its own error (`FormState`) on both pages.

Still open from that list: none beyond Processing. "Apply to all N open reports" is on hold.

---

## 3. Claims

### What gets claimed

The thing the path names: the **account** on `/reports/user`, the **model** on `/reports/model`.
Moderators collide over the account or model, through any of its reports, so claiming one report
would let two people work the same account from different reports.

### Where claims live: Redis

The moderator app already uses Redis (`$lib/server/cache.ts`, `auth.ts`). One key per item:

```
report-claim:<type>:<entityId>  →  { userId, username, since }
```

| Operation | Redis |
|---|---|
| Take | `SET key value NX EX 120` — fails if someone else holds it |
| Renew | reset the expiry, only if you hold it |
| Release | delete, only if you hold it (check-and-delete in one script, so you can't delete a claim that just passed to someone else) |
| Who holds what in this page | `MGET` over the page's 50 entity ids |

Not a moderator-database table. Reports live in the main database, so a table there can't be joined
into the queue query, and keys that expire on their own are exactly what this needs. (The scan-label
queue does use a table — `ScanLabelClaim`, a 2-minute lease — but its items live in the same database
as the lease.)

### How long a claim lasts: while it's open

Neither "until released" nor a fixed time:

- **Until released** rebuilds Processing. Closed tabs, crashed browsers and ended shifts each leave a
  lock nobody owns.
- **A fixed time** is always wrong for someone. A 500-image account outlasts it mid-review; a
  two-second spam ruling holds the item for the whole period.

So the page renews the claim about every 60 seconds while that moderator has it open, against a
~2-minute expiry (§10 Q2). It ends when they rule, skip or release, and lapses within ~2 minutes of the tab
closing or the machine sleeping.

Renewal is a small `fetch` to an endpoint, not an `invalidate`, so the queue layout still doesn't
reload.

### Only "Start working" claims

Browsing the All view and opening an item claims nothing (§10 Q1). A moderator holds only the items in
their batch (§10 Q4).

### What a claim covers, and when it ends

The item with **all its open reports** — the page lists them together (§2, item 4). Ruling on one
report doesn't release the claim; the claim ends when the item has no open reports left, when it's
skipped, set to Processing (parked) or escalated, or when work mode stops.

### Someone else's

Warn, don't block. A forgotten tab must never lock anyone out.

- Opening an item someone else holds shows "Josh is working this", with **Take over**. Taking over
  doesn't notify the previous holder (§10 Q3).
- Ruling on an item someone else holds, from outside work mode, asks first: "Josh is working this —
  rule anyway?" (§10 Q18).

---

## 4. Work mode

The same page, not a separate one.

1. **Start.** "Start working" beside the filters claims the next few unclaimed items under the current
   filters — 5 (§10 Q2) — and switches the queue column to **My batch**.
2. **Work.** As now: the first item opens, and ruling moves through its reports. When the item has
   none left, its claim is released, the next item opens, and the batch **tops itself up** with the
   next unclaimed item. It feels like a steady "next", with a few items of lookahead.
3. **Stop.** "Stop" releases what's left and returns to the full queue. Closing the tab does the same
   within ~2 minutes.

A batch you work down to zero ends with an empty column and a "claim more" step, and holds items you
haven't reached. One item at a time gives no lookahead. A small refilling batch avoids both.

- **Filters** decide what gets pulled in next. Changing them doesn't drop what you already hold.
- **URL:** My batch is a non-default, so it's `?view=mine`, and a reload stays in work mode.
- **The All view stays.** It's for searching and picking a specific item, for example from a
  `?report=` link. Rows others hold are dimmed and show who holds them.
- **Views:** the switch above the list is `All · My batch · Skipped · Parked · Escalated`. Parked is
  the Processing reports (§8). Escalated appears only with its grant.
- **Batches pull Pending items only.** A parked item isn't work anyone can do yet.
- **Counts:** the status chips add a "claimed by others" count, so it's visible how much of the queue
  is actually free (§10 Q5).
- **Timings:** batch of 5, claim expiry 120s, renewal every 60s (§10 Q2).

---

## 5. Skip — "not for me"

For "I'm not the right person", "I'm stuck", or "later".

- Releases the claim; the batch refills as if the item were done.
- Keeps the item out of **your** batch for **48 hours** (§10 Q6). Otherwise the refill would hand it
  straight back, since it's still first in the queue.
- No limit on how many you skip (§10 Q4).
- **Skipped view:** your skipped items that are still open, so you can come back to them (§10 Q4).
- **Automatic escalation:** when **3 different moderators** skip the same item within 48 hours, it is
  escalated automatically (§10 Q7, Q19), recorded as escalated by the system with the note "Skipped
  by A, B and C".

Storage, all Redis:

| Key | Holds |
|---|---|
| `report-skip:<userId>` | sorted set of `<type>:<entityId>` scored by skip time; entries older than 48h are dropped on read |
| `report-skippers:<type>:<entityId>` | sorted set of user ids scored by skip time, expiring 48h after the last skip; its 48h count is what triggers escalation |

---

## 6. Escalate — "needs someone more experienced"

Unlike a skip, this lasts, and others see it. It's what Processing never managed to be.

### Storage: a moderator-database table

```
ReportEscalation
  id, entityType, entityId          -- the account or model, as claims are
  escalatedBy, escalatedAt, note    -- note optional (§10 Q9); escalatedBy null = automatic (§10 Q7)
  resolvedBy, resolvedAt, outcome   -- outcome: 'ruled' | 'sentBack' | 'withdrawn'
  resolutionNote
```

At most one open escalation per item (a partial unique index on rows with no `resolvedAt`). It can't
be Redis: it has to survive restarts and keep who, when and why.

Same cross-database shape as claims: the queue reads the open escalations first (few rows) and leaves
those items out of normal batches.

### Why a table, not an `Escalated` report status

Decided 2026-10-15 (§10 Q28). Parking is a status plus a note (§8), so a status looked like the matching
choice here. Both need a schema change; the status needs the bigger one, and loses what escalation is for.

What a status would change:

- **The main database:** `ReportStatus` is a Postgres enum (`packages/civitai-db-schema/prisma/schema.prisma:1681`) — a Prisma
  migration and a main-app deploy.
- **ClickHouse:** the tracker writes report status to an enum column
  (`src/server/clickhouse/tracker.ts:979`), and `tracker-enum-drift.test.ts` fails if the app can
  send a value ClickHouse doesn't accept, so it needs an `ALTER` too.
- **Everything that lists statuses:** the main site's pickers, the moderator app's badges and filters,
  and the table queues, which would start showing a fourth open status.

What it would lose:

1. **History.** A status is overwritten: once a senior rules, `statusSetBy` is them, and nothing records
   who escalated, why, or whether it was sent back — no "Mine" view, no training history. The moderator
   activity log doesn't fill the gap; it records "reviewed", not which status was set.
2. **The unit.** A status is per report; escalation is per account or model. A report filed after the
   escalation would arrive Pending, outside it.
3. **The note.** `internalNotes` is the park note (§8), a single field.
4. **Sending back.** It has to restore the previous status, Pending or Processing, which a status
   can't remember.

The table costs one moderator-database migration and the cross-database read above.

### Who handles them

Moderators with the grant `reports.escalated`, labelled "Handle escalated reports" on `/admin`
(§10 Q8, Q20). It's the last step: there is no further escalation to legal or trust & safety from
here (§10 Q10).

### Where it applies

The layout queues only — `/reports/user`, `/reports/model` and `/reports/post` — not the table queues or `/reports/image` (§10 Q12).

### Vocabulary

The decisions feature already has an `escalate` ruling and an `escalated` item state
(`$lib/decision-rulings.ts:33`, `:93`). Reuse its labels and badge, so "escalated" means one thing
across the app.

---

## 7. How escalations appear

### Queue column

- The Escalated view on the switch, with its count, appears only with the grant.
- Escalated rows get a coloured left edge from a new theme token and an "Escalated" badge. The second
  line says who, how long ago, and the start of their note, so a senior can pick without opening
  each one.
- Sorted like the normal queue (§10 Q13).
- Claiming, work mode and skip all work in this view.

### In the All view, for everyone else

Shown dimmed with the badge, never pulled into My batch. Not hidden: a moderator searching for an
account should see that it's with a senior, not conclude it was never reported.

### On the open item

A banner under the account or model card:

> **Escalated by Josh, 2 hours ago:** "Profile links to a site I can't verify — might be legit art
> commissions, might be a scam."

- **With the grant:** a **Send back** button (optional note) on the banner, and the normal ruling
  buttons below it.
- **Without the grant:** ruling disabled, with "Escalated — a senior moderator will rule on this".
  The evidence stays readable.
- **The person who escalated** can **Withdraw** it ("I figured it out").

### "Mine"

A view of what you've escalated and what happened to each, including the note when one was sent back.

### Sidebar

A second count on the Reports entry for grant holders, e.g. `User reports  405 · 3⬆`. That's the only
notification — no Discord or hub message (§10 Q11).

### Resolution

- Ruling on the report closes the escalation as `ruled`.
- Send back closes it as `sentBack`, with a note.
- Withdraw closes it as `withdrawn`.

All three stay in the table, which gives a history of what gets escalated and how it turned out —
useful for training.

---

## 8. Parked — Processing with a note

For a report that can't be ruled on yet because the answer depends on something outside the queue —
chiefly an **ownership claim** under investigation, which can take weeks (§10 Q17).

No new status and no new table (§10 Q22). Processing already is this, and the report row already holds
the rest:

| Needed | Already on `Report` |
|---|---|
| What is awaited | `internalNotes`, saved by the existing `saveNotes` action |
| Since when, by whom | `statusSetAt`, `statusSetBy` |

What changes is how it's set and shown.

### Setting it

- **Any layout queue** (§10 Q23) — user, model and post.
  Anyone who can rule can park (§10 Q21).
- The Processing button becomes **Park…**: it asks for a note — what is being waited on — and saves the
  note and the status together. The note isn't required, but it's the point (§10 Q22), so the form
  asks for it rather than leaving a blank box.
- No revisit date (§10 Q22).
- **Unpark** sets it back to Pending. Ruling Actioned or Unactioned closes it, as now.

### Showing it

- In the queue it's labelled **Parked**, with the note's first line and "since 3 Oct, by Josh" on the
  row. The **Parked** view on the switch lists them.
- The open item shows a banner: *"Parked by Josh on 3 Oct: waiting on the claimant's proof of
  ownership."*
- Parked items never enter a work-mode batch (§4).

### The age alert

When a park has been open longer than **14 days** (§10 Q25), measured from `statusSetAt`, it's flagged:

- an **Overdue** badge on its row and on the banner;
- a count on the Parked view, e.g. `Parked (12 · 3 overdue)`.

This also deals with the stale Processing reports without a migration (§9): the 404 Processing user
reports would all show as overdue parks with no note, which is exactly what they are, and can be
cleared from the Parked view.

---

## 9. What changes for Processing

1. **It stays, as "parked".** Labelled Parked in the layout queues, set through Park… with a note,
   with the age alert (§8).
2. **It stops meaning "a moderator is on this".** That's the claim's job (§3).
3. **No migration for now** (§10 Q24). Existing Processing reports simply appear as parked; the
   overdue alert surfaces the stale ones for clearing by hand. If there turn out to be too many for
   that, a bulk "Unpark all overdue with no note" is the fallback, and it would need explicit approval
   because it writes to the main database.
4. **Every queue defaults to Pending only** (§10 Q27) — the layout queues and the table queues under
   `/reports/[slug]`. The sidebar badge already counts Pending only, so the badge and every queue
   finally count the same thing. Processing reports are reached through the **Parked** view on the
   layout queues and through the status filter on the tables.

   In code that's `DEFAULT_REPORT_STATUSES` (`lib/reports.ts`) becoming `[Pending]`. Two things read
   it for something else and need their own list:
   - `getReportStatusCounts` counts the **open** statuses for the status chips. It should keep counting
     Processing, so the Parked view can show its count.
   - `ReportFilters` decides which chips carry a count from the same list.

   The table queues write the default into the URL (`?status=Pending&status=Processing` today), so
   their links change to `?status=Pending`. An old link with both still works; it just shows both.

This step is independent of the rest and can ship first.

---

## 10. Open questions

Every question in this plan, with its answer. The body above reflects every answer.

**Still open:** Q26 — Processing back on the user queue as Park…. (Q14 is replaced by Q24.)

Answer on the `@dev:` line under each.

### Claims

1. Claim automatically when someone opens an item in the All view, or only through "Start working"? (Leaning: automatic for the open item, "Start working" for the lookahead batch.)

   @dev: Not sure what you mean by "automatic" for the open item. I think that, generally speaking, a mod should click "start working" to claim items.

   > **Update (from the parent session):** "Automatic" meant: just *opening* an item in the All view would claim it, with no button. Your answer settles it — browsing claims nothing; only "Start working" does. What's left is what happens when someone outside work mode rules on an item another moderator holds — see Q18.

2. Batch size, claim expiry and renewal interval? (Proposed: 5 items, 120s expiry, 60s renewal.)

   @dev: This sounds good

3. Does "Take over" notify the previous holder?

   @dev: Don't need to notify the previous holder.

4. Should there be a limit on how many items one moderator can hold or skip?

   @dev: A moderator should only hold the current items they are working on. We have that limit already set. They can skip as many as they want. They should be able to view skipped items that are still open.

   > **Update (from the parent session):** "Current items" is now an **item with all its open reports**, not a report (Q16). So a claim is released when the item has no open reports left — not after each ruling — which matches how the page now moves on. The "Skipped" view joins the queue switch: `All · My batch · Skipped · Parked · Escalated` (§4).

5. Should the status chips show a "claimed by others" count (§4)?

   @dev: yes

### Skip

6. How long should a skip last — the end of a shift (say 8 hours), the end of the day, or until the moderator stops work mode?

   @dev: Make a skip last 48 hours. The user can always review their skipped items if they want to come back to them.

7. Should items skipped by several moderators be surfaced somewhere (§5), or just counted?

   @dev: Items skipped by several moderators should be automatically escalated

   > **Update (from the parent session):** This needs a per-item skip count across moderators, kept as long as a skip lasts (48 hours, Q6), and a threshold — Q19. An automatic escalation would be recorded as escalated by the system, with a note like "Skipped by 3 moderators" listing who.

### Escalation

8. Who holds `reports.escalated` — a role, or granted per person?

   @dev: I'm thinking that escalated can be a permission grant

   > **Update (from the parent session):** The grant needs a name and a label for `/admin` — Q20.

9. Is the note required?

   @dev: no

10. Can a senior escalate further, e.g. to legal or trust & safety? Or is that a separate path?

   @dev: no

11. Should escalations notify anyone — Discord, the hub — or is the sidebar count enough?

   @dev: sidebar count should be enough

12. Does escalation apply to the table queues too, or only layout pages?

   @dev: let's restrict it to the layout pages for now

13. Should the Escalated view sort oldest first (§7), unlike the normal queue?

   @dev: no

   > **Update (from the parent session):** So the Escalated view sorts like the normal queue (newest first).

### Processing

14. Approve the stale Processing → Pending reset (§9, step 2), and when?

   @dev:

   > **Update (from the parent session):** New information makes this premature. A comment in `lib/reports.ts` (the badge definition) says a moderator sets Processing *"while investigating an ownership claim, which can run for weeks"*. Ownership claims are model reports. If that's still how mods work, some of the 404 Processing reports may be live investigations, not stale claims, and a blanket reset would lose that. This waits on Q17.

### Page standard (§2)

15. Paging: keep the open item, or open the new page's first?

   @dev: open the new page's first

   > **Update (from the parent session):** Done in code, on both pages.

16. What the path names for a new type: the content (all its reports together) or one report?

   @dev: It will be all its reports together. We've already made changes to support this.

   > **Update (from the parent session):** Done in code, on both pages. It also changes what a claim covers — see the note on Q4.

### Added after the answers

17. Do moderators still set Processing on model reports to mean "ownership claim under investigation", sometimes for weeks? If yes, a 2-minute claim can't carry that, and it needs its own lasting state. Options: (a) keep Processing for that one use on the model queue only; (b) make it an escalation with a note; (c) a separate "on hold" record in the moderator database, like escalation but without the senior hand-off.

   @dev: yes. I wonder if we need to have a better way to "park" a model report

   > **Update:** Designed as **Park** (§8): Processing plus the report's own `internalNotes` — no new table. Q21–Q23 settle its details.

18. Outside work mode, someone rules on an item another moderator has claimed. Warn first ("Josh is working this — rule anyway?"), or just show the holder's name and let it through?

   @dev: warn

19. How many distinct moderators skipping an item (within the 48 hours) triggers the automatic escalation? (Proposed: 3.)

   @dev: 3

20. The escalation grant's name and `/admin` label. (Proposed: `reports.escalated`, "Handle escalated reports".)

   @dev: yes

### Parking

21. Who can park: anyone who can rule on the queue, or a grant like escalation?

   @dev: anyone

22. Is the revisit date required, and is there a default (say 14 days)? Without one, a park can sit forever — Processing's problem again.

   @dev: dates aren't required. I'm not sure if we actually need a "parked" status. It depends on if I can set a model to processing and leave a note. The important thing is that we are able to leave a note. We should probably show some sort of alert when parked/processing models have been that way for longer than a certain period of time.

   > **Update:** You can, today: `Report` has `internalNotes` (the model page's "Internal notes" box, saved by `saveNotes`), plus `statusSetAt` and `statusSetBy`. So parked **is** Processing with a note — no new status or table. §8 now describes it that way, with the age alert; the threshold is Q25.

23. Parking for model reports only, or every layout queue? (Proposed: both layout queues, since it costs nothing extra; only models need it today.)

   @dev: We can do it for any layout queue

   > **Update:** This reverses an earlier call. On 2026-10-14 the user queue was set to Actioned/Unactioned only ("Don't enable it", when Processing still meant claiming). Parking on the user queue means offering Processing there again, as Park… — Q26 confirms.

24. Approve the Processing migration in §9 step 2 (model reports → parks, everything else → Pending), and when?

   @dev: Not sure if we need a migration yet.

   > **Update:** With Processing kept as "parked", none is needed to start. §9 step 3.

### Added after the parking answers

25. After how long is a park flagged overdue? (Proposed: 30 days — most ownership claims should move within that, and every one of the 404 stale user reports is past it.)

   @dev: 14 days

   > **Recorded** in §8. With ownership claims often running for weeks, expect many parks to show as overdue; that is the point — someone looks at each one every 14 days.

26. Confirm Processing comes back on the user queue as Park… (see the note on Q23), reversing "Don't enable it" from 2026-10-14.

   @dev:

27. Should the All view default to Pending only, with parked items in the Parked view? Today it defaults to Pending + Processing, which is why the sidebar badge (Pending only) and the queue disagree.

   @dev: pending only. Should be the same for all queues

   > **Recorded** in §9 step 4, table queues included. Two places read the default list for something else and need separating — noted there.

### Decided outside the questions

28. Escalation: a moderator-database table, or a new `Escalated` report status?

   @dev: I think your plan is good.

   > Recorded as: the `ReportEscalation` table. Reasons in §6, "Why a table, not an Escalated report status".

---

## 11. Order of work

1. **Page standard** — done (45a3e3ca87, §2).
2. **Pending-only default** — §9 step 4. Every queue, one constant and the two readers it needs
   separating from. Small, and fixes the badge mismatch on its own.
   ⚠️ Until the Parked view (step 5) exists, parked model reports drop out of the default view and are
   reachable only by ticking Processing in the status filter. If that is too hidden for ownership
   claims, ship this together with step 5.
3. **Claims + work mode** — Redis claim helpers, renewal endpoint, the view switch, dimmed rows,
   Take over, the rule-anyway warning. User and model queues together.
4. **Skip** — including the Skipped view.
5. **Parking** — Park… with a note, the Parked label and view, the banner, the overdue alert. Small,
   no schema change, and it can ship first: it's independent of claims.
6. **Escalation** — the `ReportEscalation` table and migration in the moderator database, the grant,
   the Escalated view, the banner, Mine, the sidebar count, automatic escalation from skips.

Each step ships on its own. Claims are useful without escalation, escalation without work mode, and
parking without either.
